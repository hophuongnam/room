# services.rb
require 'dotenv/load'
# Force the environment to UTC, ignoring system timezone
ENV['TZ'] = 'UTC'

require 'sqlite3'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'json'
require 'securerandom'
require 'time'

CREDENTIALS_PATH = 'credentials.json'
REDIRECT_URI     = ENV['REDIRECT_URI']
WEBHOOK_ADDRESS  = ENV['WEBHOOK_ADDRESS']
DB_PATH          = 'users.db'

# Global in-memory structures (shared with app.rb).
$calendar_watch_map  = {}
$room_update_tracker = Hash.new(0)
$rooms_data          = {}

# -------------------------------------------------------
# NEW: Store sync tokens for partial sync
# Key: calendar_id => sync_token
# If we do not have a token or token is invalid => full fetch
# -------------------------------------------------------
$sync_tokens ||= {}

def initialize_database
  db = SQLite3::Database.new(DB_PATH)
  db.execute <<-SQL
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE,
      is_organizer BOOLEAN DEFAULT FALSE,
      credentials TEXT
    );
  SQL
  db
end

def load_organizer_credentials
  db = initialize_database
  row = db.execute("SELECT email, credentials FROM users WHERE is_organizer = 1 LIMIT 1").first
  halt 500, { error: 'No organizer found.' }.to_json unless row

  email, credentials_json = row
  halt 500, { error: 'No credentials found for organizer.' }.to_json unless credentials_json

  credentials_hash = JSON.parse(credentials_json)
  expiry = credentials_hash['expiry']
  parsed_expiry = if expiry.is_a?(String)
                    Time.parse(expiry)
                  elsif expiry.is_a?(Integer)
                    Time.at(expiry)
                  else
                    raise "Invalid expiry format"
                  end

  credentials = Google::Auth::UserRefreshCredentials.new(
    client_id:     credentials_hash['client_id'],
    client_secret: credentials_hash['client_secret'],
    scope:         credentials_hash['scope'],
    access_token:  credentials_hash['access_token'],
    refresh_token: credentials_hash['refresh_token'],
    expires_at:    parsed_expiry,
    redirect_uri:  credentials_hash['redirect_uri'] || REDIRECT_URI
  )

  if credentials.expired?
    begin
      credentials.refresh!
      db.execute("UPDATE users SET credentials = ? WHERE email = ?", [credentials.to_json, email])
      # If refresh succeeds, mark token usable again
      $token_usable = true
    rescue => e
      # If refreshing fails, mark token as unusable
      $token_usable = false
      puts "Error refreshing token for organizer: #{e.message}"
      halt 500, { error: 'Organizer credentials invalid. Please re-authenticate.' }.to_json
    end
  end

  credentials
end

def parse_room_role_and_links(cal)
  desc = cal.description.to_s
  role = 'normal'
  sub_rooms = []
  super_room = nil

  desc.lines.each do |line|
    line.strip!
    if line.start_with?('role:')
      role = line.split(':', 2)[1].strip.downcase
    elsif line.start_with?('sub:')
      sub_name = line.split(':', 2)[1].strip
      sub_rooms << sub_name unless sub_name.empty?
    elsif line.start_with?('super:')
      super_name = line.split(':', 2)[1].strip
      super_room = super_name unless super_name.empty?
    end
  end

  {
    role:       role,
    sub_rooms:  sub_rooms,
    super_room: super_room
  }
end

def fetch_events_for_calendar(calendar_id, service = nil)
  # Re-use or create a new CalendarService.
  # If you've already got a service instance, pass it in to avoid reloading credentials each time.
  service ||= begin
    s = Google::Apis::CalendarV3::CalendarService.new
    s.authorization = load_organizer_credentials
    s
  end

  # Attempt partial sync if we have a token
  token = $sync_tokens[calendar_id]
  result = nil

  begin
    if token
      # PARTIAL SYNC
      result = service.list_events(
        calendar_id,
        single_events: true,
        order_by:      'startTime',
        sync_token:    token
      )
    else
      # FULL FETCH
      time_min_utc = (Time.now.utc - 7 * 86400).iso8601
      result = service.list_events(
        calendar_id,
        single_events: true,
        order_by:      'startTime',
        time_min:      time_min_utc
      )
    end

  rescue Google::Apis::ClientError => e
    # If the sync token is invalid/expired, Google returns 410
    if e.status_code == 410
      $sync_tokens.delete(calendar_id)

      # Retry with a full fetch
      time_min_utc = (Time.now.utc - 7 * 86400).iso8601
      result = service.list_events(
        calendar_id,
        single_events: true,
        order_by:      'startTime',
        time_min:      time_min_utc
      )
    else
      raise
    end
  end

  # If the result exists, log how many items were returned
  if result

    # Check if we got a new sync token
    if result.next_sync_token
      $sync_tokens[calendar_id] = result.next_sync_token
    else
    end
  else
  end

  # Convert the Event objects into your local format (hashes, etc.)
  # Adjust the map logic to suit your needs or keep it inline:
  events = result ? result.items.map { |item| parse_event(item) } : []
  return events
end

def parse_event(item)
  # Helper method to parse the Google::Apis::CalendarV3::Event object
  # into a Ruby hash. You can customize as needed:
  {
    id:        item.id,
    title:     item.summary,
    start:     item.start&.date_time || item.start&.date,
    end:       item.end&.date_time   || item.end&.date,
    attendees: (item.attendees || []).map(&:email),
    extendedProps: {
      organizer:  item.extended_properties&.private&.[]('creator_email') ||
                  item.organizer&.email,
      is_linked:  (item.extended_properties&.private&.[]('is_linked') == 'true'),
      original_calendar_id: item.extended_properties&.private&.[]('original_calendar_id'),
      original_event_id:    item.extended_properties&.private&.[]('original_event_id'),
      description:          item.description || ""
    }
    # Additional fields as needed...
  }
end

def determine_linked_event_color(current_calendar_id, original_calendar_id)
  return '' if original_calendar_id.nil? || original_calendar_id == current_calendar_id
  '#ff0000'
end

def load_and_watch_all_rooms
  puts "Loading room calendars and setting up watches..."
  credentials = load_organizer_credentials
  service     = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendar_list = service.list_calendar_lists
  room_calendars = calendar_list.items.select do |cal|
    cal.description.to_s.include?('type:room')
  end

  room_calendars.each do |cal|
    parsed = parse_room_role_and_links(cal)

    $rooms_data[cal.id] = {
      calendar_info: {
        id: cal.id,
        summary: cal.summary,
        description: cal.description
      },
      role:       parsed[:role],
      sub_rooms:  parsed[:sub_rooms],
      super_room: parsed[:super_room],
      events:     fetch_events_for_calendar(cal.id, service),
      last_fetched: Time.now
    }

    setup_watch_for_calendar(cal.id, service)
  end
  puts "Finished loading room calendars."
end

def setup_watch_for_calendar(calendar_id, service = nil)
  service ||= begin
    s = Google::Apis::CalendarV3::CalendarService.new
    s.authorization = load_organizer_credentials
    s
  end

  channel = Google::Apis::CalendarV3::Channel.new(
    id: SecureRandom.uuid,
    type: 'webhook',
    address: WEBHOOK_ADDRESS
  )

  begin
    response = service.watch_event(calendar_id, channel)
    resource_id = response.resource_id
    $calendar_watch_map[resource_id] = calendar_id
    puts "Watch set up for calendar: #{calendar_id}, resource_id=#{resource_id}"
  rescue Google::Apis::ClientError => e
    puts "Error setting up watch for #{calendar_id}: #{e.message}"
  end
end

def refresh_room_calendars
  puts 'Refreshing room calendars...'
  credentials = load_organizer_credentials
  service     = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendar_list = service.list_calendar_lists
  room_calendars = calendar_list.items.select do |cal|
    cal.description.to_s.include?('type:room')
  end

  room_calendars.each do |cal|
    setup_watch_for_calendar(cal.id, service)
  end

  puts 'Room calendars refreshed and watches updated.'
end