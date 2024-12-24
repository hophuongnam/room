require 'sqlite3'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'json'
require 'securerandom'
require 'dotenv/load'

CREDENTIALS_PATH = 'credentials.json'
REDIRECT_URI = "https://room.mefat.review/oauth2callback"
DB_PATH = 'users.db'

# Initialize database
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

# Load organizer credentials
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

# Push Notification Watch
def setup_watch(calendar_id)
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  channel = Google::Apis::CalendarV3::Channel.new(
    id: SecureRandom.uuid,  # Unique ID for the subscription
    type: 'webhook',
    address: 'https://room.mefat.review/notifications'  # Your webhook URL
  )

  begin
    service.watch_event(calendar_id, channel)
    puts "Watch set up successfully for calendar: #{calendar_id}"
  rescue Google::Apis::ClientError => e
    puts "Error setting up watch: #{e.message}"
  end
end

# Watch Calendar List for Changes
def setup_calendar_list_watch
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  channel = Google::Apis::CalendarV3::Channel.new(
    id: SecureRandom.uuid,  # Unique ID for the subscription
    type: 'webhook',
    address: 'https://room.mefat.review/notifications'  # Your webhook URL
  )

  begin
    service.watch_calendar_list(channel)
    puts 'Calendar list watch set up successfully'
  rescue Google::Apis::ClientError => e
    puts "Error setting up calendar list watch: #{e.message}"
  end
end

# Refresh Room Calendars
def refresh_room_calendars
  puts 'Refreshing room calendars...'
  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendars = service.list_calendar_lists
  room_calendars = calendars.items.select { |cal| cal.description&.include?('type:room') }

  room_calendars.each do |calendar|
    setup_watch(calendar.id)
  end

  puts 'Room calendars refreshed and watches updated.'
end
