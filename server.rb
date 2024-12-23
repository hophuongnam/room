require 'sinatra'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'sqlite3'
require 'json'
require 'dotenv/load'

# Configuration
CREDENTIALS_PATH = 'credentials.json'
REDIRECT_URI = 'http://localhost:3000/oauth2callback'
DB_PATH = 'users.db'
USER_SCOPES = ['openid', 'email', 'profile']
ORGANIZER_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
]

# Enable sessions with a secure secret
enable :sessions
set :session_secret, ENV['SESSION_SECRET'] || 'fallback_super_secure_secret_key'

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
# API Routes
get '/' do
  send_file File.join(settings.public_folder, 'index.html')
end

get '/api/rooms' do
  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  calendars = service.list_calendar_lists
  room_calendars = calendars.items.select { |cal| cal.description&.include?('type:room') }

  content_type :json
  { rooms: room_calendars.map { |cal| { id: cal.id, summary: cal.summary } } }.to_json
end

get '/api/events' do
  calendar_id = params['calendarId']
  halt 400, { error: 'Missing calendarId' }.to_json unless calendar_id

  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  events = service.list_events(calendar_id, single_events: true, order_by: 'startTime')
  content_type :json
  {
    events: events.items.map do |event|
      {
        id: event.id,
        title: event.summary, # Mapping Google Calendar's "summary" to "title" for FullCalendar
        start: event.start.date_time || event.start.date,
        end: event.end.date_time || event.end.date,
        attendees: event.attendees&.map { |att| att.email } || []
      }
    end
  }.to_json
end

post '/api/create_event' do
  request_data = JSON.parse(request.body.read)
  calendar_id = request_data['calendarId']
  title = request_data['title']
  start_time = request_data['start']
  end_time = request_data['end']
  participants = request_data['participants'] || []

  halt 400, { error: 'Missing required fields' }.to_json unless calendar_id && title && start_time && end_time

  creator_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless creator_email

  attendees = (participants + [creator_email]).uniq.reject(&:empty?).map { |email| { email: email } }

  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  event = Google::Apis::CalendarV3::Event.new(
    summary: title,
    start: { date_time: start_time, time_zone: 'UTC' },
    end: { date_time: end_time, time_zone: 'UTC' },
    attendees: attendees
  )

  result = service.insert_event(calendar_id, event)
  content_type :json
  { event_id: result.id, status: 'success' }.to_json
end

delete '/api/delete_event' do
  request_data = JSON.parse(request.body.read)
  calendar_id = request_data['calendarId']
  event_id = request_data['id']

  halt 400, { error: 'Missing required fields' }.to_json unless calendar_id && event_id

  credentials = load_organizer_credentials
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = credentials

  service.delete_event(calendar_id, event_id)
  content_type :json
  { status: 'success' }.to_json
end

set :port, 3000
