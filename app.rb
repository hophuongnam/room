require 'dotenv/load'               # Load .env variables (if using dotenv)
require 'sinatra'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'rufus-scheduler'
require 'json'
require 'base64'
require 'sqlite3'
require_relative 'services'

# -------------------------------------------------
# Read environment variables
# -------------------------------------------------
PORT            = ENV['PORT'] ? ENV['PORT'].to_i : 3000
SESSION_SECRET  = ENV['SESSION_SECRET'] || 'fallback_super_secure_secret_key'

USER_OAUTH_SCOPE = ['openid','email','profile']

# -------------------------------------------------
# Database & Basic Config
# -------------------------------------------------
def user_db
  @user_db ||= SQLite3::Database.new(DB_PATH)
end

# Enable sessions
enable :sessions
set :session_secret, SESSION_SECRET

# -------------------------------------------------
# Server-Side Guard for Auth
# -------------------------------------------------
before do
  protected_paths = [
    '/api/rooms',
    '/api/room_data',
    '/api/room_updates',
    '/api/events',
    '/api/create_event',
    '/api/delete_event'
  ]
  if protected_paths.include?(request.path_info)
    unless session[:user_email]
      halt 401, { error: 'Unauthorized' }.to_json
    end
  end
end

# Global data structures (from your base code)
scheduler = Rufus::Scheduler.new

# -------------------------------------------------
# Load & Watch All Rooms on Startup
# -------------------------------------------------
Thread.new do
  sleep 3
  load_and_watch_all_rooms  # from services.rb (unchanged)
end

# -------------------------------------------------
# Normal User OAuth Flow
# -------------------------------------------------
# 1) Initiate user login
get '/login' do
  client_id  = Google::Auth::ClientId.from_file(CREDENTIALS_PATH)
  authorizer = Google::Auth::UserAuthorizer.new(client_id, USER_OAUTH_SCOPE, nil)

  auth_url = authorizer.get_authorization_url(
    base_url: REDIRECT_URI,
    state: 'user_auth'
  )

  redirect auth_url
end

# 2) Handle user callback in the same /oauth2callback route, but different state
get '/oauth2callback' do
  code  = params['code']
  state = params['state']

  if state == 'user_auth'
    client_id  = Google::Auth::ClientId.from_file(CREDENTIALS_PATH)
    authorizer = Google::Auth::UserAuthorizer.new(client_id, USER_OAUTH_SCOPE, nil)

    credentials = authorizer.get_credentials_from_code(
      user_id: 'basic_user',
      code: code,
      base_url: REDIRECT_URI
    )

    # Extract user info from ID token
    id_token = credentials.id_token
    if id_token.nil?
      return "Could not retrieve user info. Check scopes."
    end

    payload   = JSON.parse(Base64.decode64(id_token.split('.')[1]))
    email     = payload['email']
    full_name = payload['name']    rescue nil
    picture   = payload['picture'] rescue nil

    # Store the user info in DB if not present
    user_db.execute <<-SQL
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        is_organizer BOOLEAN DEFAULT FALSE,
        credentials TEXT,
        name TEXT,
        picture TEXT
      );
    SQL

    # Insert or update the user's name/picture
    user_db.execute("INSERT OR IGNORE INTO users (email, name, picture) VALUES (?, ?, ?)",
                    [email, full_name, picture])
    user_db.execute("UPDATE users SET name=?, picture=? WHERE email=?",
                    [full_name, picture, email])

    # Set session
    session[:user_email]   = email
    session[:user_name]    = full_name
    session[:user_picture] = picture

    redirect '/'
  else
    # If it's not setup_organizer (handled in setup.rb) or user_auth
    "Invalid state for user auth. Access denied."
  end
end

# -------------------------------------------------
# Logout
# -------------------------------------------------
get '/logout' do
  session.clear
  redirect '/'
end

# -------------------------------------------------
# API Endpoint: Check if user is logged in
# -------------------------------------------------
get '/api/me' do
  if session[:user_email]
    content_type :json
    {
      email: session[:user_email],
      name: session[:user_name],
      picture: session[:user_picture]
    }.to_json
  else
    halt 401, { error: 'Not logged in' }.to_json
  end
end

# -------------------------------------------------
# API Endpoint: Query User Details
# -------------------------------------------------
# /api/user_details?email=someone@example.com
get '/api/user_details' do
  content_type :json
  email = params['email']
  halt 400, { error: 'Missing email param' }.to_json if !email || email.strip.empty?

  row = user_db.execute("SELECT email, name, picture FROM users WHERE email=?", [email]).first
  halt 404, { error: 'User not found' }.to_json unless row

  { email: row[0], name: row[1], picture: row[2] }.to_json
end

# -------------------------------------------------
# Webhook for Push Notifications
# -------------------------------------------------
post '/notifications' do
  request_body = request.body.read
  headers = request.env.select { |k, _| k.start_with?('HTTP_') }

  puts "Notification Headers: #{headers.inspect}"
  puts "Notification Body: #{request_body}"

  resource_id    = headers['HTTP_X_GOOG_RESOURCE_ID']
  resource_state = headers['HTTP_X_GOOG_RESOURCE_STATE']

  calendar_id = $calendar_watch_map[resource_id]
  unless calendar_id
    puts "Unknown resource_id=#{resource_id}; ignoring."
    halt 200
  end

  case resource_state
  when 'sync', 'exists', 'updated'
    puts "Push notification: calendar=#{calendar_id} changed (state=#{resource_state})."
    service = Google::Apis::CalendarV3::CalendarService.new
    service.authorization = load_organizer_credentials

    updated_events = fetch_events_for_calendar(calendar_id, service)
    if $rooms_data[calendar_id]
      $rooms_data[calendar_id][:events] = updated_events
      $rooms_data[calendar_id][:last_fetched] = Time.now
    else
      $rooms_data[calendar_id] = {
        calendar_info: { id: calendar_id, summary: 'Unknown', description: '' },
        events: updated_events,
        last_fetched: Time.now
      }
    end
    $room_update_tracker[calendar_id] += 1

  when 'deleted'
    puts "Channel/resource deleted: #{resource_id}"
    $calendar_watch_map.delete(resource_id)
  else
    puts "Unhandled resource state: #{resource_state}"
  end

  status 200
end

# -------------------------------------------------
# Room/Events Endpoints
# -------------------------------------------------
get '/api/room_updates' do
  content_type :json
  updates = $room_update_tracker.map do |cal_id, ver|
    { roomId: cal_id, version: ver }
  end
  { updates: updates }.to_json
end

get '/api/room_data' do
  content_type :json
  calendar_id = params['calendarId']
  halt 400, { error: 'Missing calendarId' }.to_json unless calendar_id

  room_info = $rooms_data[calendar_id]
  halt 404, { error: 'Room not found' }.to_json unless room_info

  {
    calendar_info: room_info[:calendar_info],
    events: room_info[:events],
    last_fetched: room_info[:last_fetched]
  }.to_json
end

get '/api/rooms' do
  rooms_array = $rooms_data.map do |cal_id, data|
    {
      id: cal_id,
      summary: data[:calendar_info][:summary],
      description: data[:calendar_info][:description]
    }
  end

  sorted = rooms_array.sort_by do |room|
    match = room[:description].to_s.match(/order:(\d+)/)
    match ? match[1].to_i : Float::INFINITY
  end

  content_type :json
  { rooms: sorted }.to_json
end

# Optional: direct Google fetch
get '/api/events' do
  calendar_id = params['calendarId']
  halt 400, { error: 'Missing calendarId' }.to_json unless calendar_id

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials
  events = service.list_events(calendar_id, single_events: true, order_by: 'startTime')

  content_type :json
  {
    events: events.items.map do |event|
      {
        id: event.id,
        title: event.summary,
        start: event.start.date_time || event.start.date,
        end: event.end.date_time || event.end.date,
        attendees: event.attendees&.map(&:email) || []
      }
    end
  }.to_json
end

# Helper: Check Overlap
def events_overlap?(calendar_id, start_time_utc, end_time_utc)
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  time_min = start_time_utc.iso8601
  time_max = end_time_utc.iso8601

  events = service.list_events(
    calendar_id,
    single_events: true,
    order_by: 'startTime',
    time_min: time_min,
    time_max: time_max
  )

  events.items.any?
end

post '/api/create_event' do
  request_data   = JSON.parse(request.body.read)
  calendar_id    = request_data['calendarId']
  title          = request_data['title']
  start_time_str = request_data['start']
  end_time_str   = request_data['end']
  participants   = request_data['participants'] || []

  halt 400, { error: 'Missing fields' }.to_json unless calendar_id && title && start_time_str && end_time_str

  creator_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless creator_email

  start_time_utc = Time.parse(start_time_str).utc
  end_time_utc   = Time.parse(end_time_str).utc

  if events_overlap?(calendar_id, start_time_utc, end_time_utc)
    halt 409, { error: 'Time slot overlaps an existing event' }.to_json
  end

  # The real 'creator' is stored in extended properties
  attendees_emails = (participants + [creator_email]).uniq.reject(&:empty?)
  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  event = Google::Apis::CalendarV3::Event.new(
    summary: title,
    start: { date_time: start_time_utc.iso8601, time_zone: 'UTC' },
    end:   { date_time: end_time_utc.iso8601,   time_zone: 'UTC' },
    attendees: attendees_emails.map { |em| { email: em } },
    extended_properties: {
      private: {
        creator_email: creator_email
      }
    }
  )

  result = service.insert_event(calendar_id, event)
  content_type :json
  { event_id: result.id, status: 'success' }.to_json
end

delete '/api/delete_event' do
  request_data = JSON.parse(request.body.read)
  calendar_id  = request_data['calendarId']
  event_id     = request_data['id']

  halt 400, { error: 'Missing required fields' }.to_json unless calendar_id && event_id
  user_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless user_email

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  event = service.get_event(calendar_id, event_id)
  all_attendees = (event.attendees || []).map(&:email)
  creator_email = event.extended_properties&.private&.[]('creator_email')

  unless all_attendees.include?(user_email) || (creator_email == user_email)
    halt 403, { error: 'You do not have permission to delete this event' }.to_json
  end

  service.delete_event(calendar_id, event_id)
  content_type :json
  { status: 'success' }.to_json
end

# Scheduler
scheduler.every '23h' do
  begin
    puts 'Renewing watches for all room calendars...'
    refresh_room_calendars
  rescue => e
    puts "Error renewing watches: #{e.message}"
  end
end

# Serve index
get '/' do
  send_file File.join(settings.public_folder, 'index.html')
end

set :environment, :production
set :port, PORT
