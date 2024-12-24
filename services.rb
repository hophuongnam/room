require 'sqlite3'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'json'
require 'securerandom'
require 'dotenv/load'
require 'time'

CREDENTIALS_PATH = 'credentials.json'
REDIRECT_URI = "https://room.mefat.review/oauth2callback"
DB_PATH = 'users.db'

# Global in-memory structures (shared with app.rb).
# You could also define them in app.rb if preferred.
# -------------------------------------------------
# Maps Google watch channel's resource_id -> calendar_id
$calendar_watch_map = {}
# Stores a "version counter" or "changed flag" for each calendar
$room_update_tracker = Hash.new(0)
# Stores the actual event data for each calendar
# Example structure: 
#   $rooms_data[calendar_id] = { 
#     :calendar_info => { ... }, 
#     :events => [...], 
#     :last_fetched => Time.now 
#   }
$rooms_data = {}

# -------------------------------------------------
# Database / Credentials
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
# Fetch & Cache Room Calendars / Events
# -------------------------------------------------

# Called at server startup to:
# 1) Fetch all room calendars
# 2) Cache their event data
# 3) Set up watches
def load_and_watch_all_rooms
  puts "Loading room calendars and setting up watches..."
  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendar_list = service.list_calendar_lists
  # Filter out "room" calendars by description
  room_calendars = calendar_list.items.select { |cal| cal.description&.include?('type:room') }

  # For each room calendar, fetch events and store in memory
  room_calendars.each do |cal|
    $rooms_data[cal.id] = {
      calendar_info: {
        id: cal.id,
        summary: cal.summary,
        description: cal.description
      },
      events: fetch_events_for_calendar(cal.id, service),
      last_fetched: Time.now
    }
    # Then set up a watch for the calendar
    setup_watch_for_calendar(cal.id, service)
  end
  puts "Finished loading room calendars."
end

# Utility to fetch events for a calendar
def fetch_events_for_calendar(calendar_id, service = nil)
  service ||= begin
    s = Google::Apis::CalendarV3::CalendarService.new
    s.authorization = load_organizer_credentials
    s
  end
  result = service.list_events(calendar_id, single_events: true, order_by: 'startTime')
  result.items.map do |event|
    {
      id: event.id,
      title: event.summary,
      start: event.start.date_time || event.start.date,
      end: event.end.date_time || event.end.date,
      attendees: event.attendees&.map(&:email) || []
    }
  end
end

# -------------------------------------------------
# Push Notification Watch
# -------------------------------------------------
def setup_watch_for_calendar(calendar_id, service = nil)
  service ||= begin
    s = Google::Apis::CalendarV3::CalendarService.new
    s.authorization = load_organizer_credentials
    s
  end

  channel = Google::Apis::CalendarV3::Channel.new(
    id: SecureRandom.uuid,  # Unique channel ID
    type: 'webhook',
    address: 'https://room.mefat.review/notifications'  # Your webhook endpoint
  )

  begin
    response = service.watch_event(calendar_id, channel)
    resource_id = response.resource_id
    # Store resource_id -> calendar_id in our global map
    $calendar_watch_map[resource_id] = calendar_id
    puts "Watch set up for calendar: #{calendar_id}, resource_id=#{resource_id}"
  rescue Google::Apis::ClientError => e
    puts "Error setting up watch for #{calendar_id}: #{e.message}"
  end
end

# You might or might not need a watch on the calendar list itself;
# depends on your use case. For now, we'll skip watch_calendar_list
# since we want event changes specifically, not list changes.

# -------------------------------------------------
# Refresh Room Calendars (re-establish watches)
# Called periodically by Rufus-scheduler
# -------------------------------------------------
def refresh_room_calendars
  puts 'Refreshing room calendars...'
  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendar_list = service.list_calendar_lists
  room_calendars = calendar_list.items.select { |cal| cal.description&.include?('type:room') }

  room_calendars.each do |cal|
    setup_watch_for_calendar(cal.id, service)
  end

  puts 'Room calendars refreshed and watches updated.'
end
