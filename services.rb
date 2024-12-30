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

# -------------------------------------------------
# Database
# -------------------------------------------------
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
    client_id: credentials_hash['client_id'],
    client_secret: credentials_hash['client_secret'],
    scope: credentials_hash['scope'],
    access_token: credentials_hash['access_token'],
    refresh_token: credentials_hash['refresh_token'],
    expires_at: parsed_expiry,
    redirect_uri: credentials_hash['redirect_uri'] || REDIRECT_URI
  )

  if credentials.expired?
    credentials.refresh!
    db.execute("UPDATE users SET credentials = ? WHERE email = ?", [credentials.to_json, email])
  end

  credentials
end

# -------------------------------------------------
# Parse room role (super / sub / normal) from description
# -------------------------------------------------
def parse_room_role_and_links(cal)
  desc = cal.description.to_s
  role = 'normal'
  sub_rooms = []
  super_room = nil

  # We assume the description might look like:
  #   "role: super\nsub: Room B\nsub: Room C"
  # or "role: sub\nsuper: Room A"
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
    sub_rooms:  sub_rooms,     # array of names
    super_room: super_room     # name string
  }
end

# -------------------------------------------------
# Fetch events (7 days in the past onward)
# -------------------------------------------------
def fetch_events_for_calendar(calendar_id, service = nil)
  service ||= begin
    s = Google::Apis::CalendarV3::CalendarService.new
    s.authorization = load_organizer_credentials
    s
  end

  time_min_utc = (Time.now.utc - 7 * 86400).iso8601

  result = service.list_events(
    calendar_id,
    single_events: true,
    order_by: 'startTime',
    time_min: time_min_utc
  )

  this_room_data = $rooms_data[calendar_id]
  this_role      = this_room_data ? this_room_data[:role] : 'normal'

  result.items.map do |event|
    priv      = event.extended_properties&.private
    is_linked = (priv && priv['is_linked'] == 'true')
    orig_cal  = priv && priv['original_calendar_id']
    orig_ev_id= priv && priv['original_event_id']

    border_color = determine_linked_event_color(calendar_id, orig_cal)

    {
      id: event.id,
      title: event.summary,
      start: event.start.date_time || event.start.date,
      end:   event.end.date_time   || event.end.date,
      attendees: (event.attendees&.map(&:email) || []),
      extendedProps: {
        organizer: priv&.[]('creator_email') || event.organizer&.email,
        is_linked: is_linked,
        original_calendar_id: orig_cal,
        original_event_id:    orig_ev_id
      },
      borderColor: border_color
    }
  end
end

def determine_linked_event_color(current_calendar_id, original_calendar_id)
  return '' if original_calendar_id.nil? || original_calendar_id == current_calendar_id
  '#ff0000'
end

# -------------------------------------------------
# Called once on startup, loads all "type:room" calendars
# Also sets up watch channels for push notifications
# -------------------------------------------------
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

# -------------------------------------------------
# Set up push notification watch for a calendar
# -------------------------------------------------
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

# -------------------------------------------------
# Refresh watch channels for all known room calendars
# -------------------------------------------------
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
