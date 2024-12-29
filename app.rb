require 'dotenv/load'
# Force the environment to UTC, ignoring system timezone
ENV['TZ'] = 'UTC'

require 'sinatra'
require 'google/apis/calendar_v3'
require 'googleauth'
require 'rufus-scheduler'
require 'json'
require 'base64'
require 'sqlite3'
require 'time'
require_relative 'services'  # Contains fetch_events_for_calendar, etc.

# -------------------------------------------------
# Environment & Basic Config
# -------------------------------------------------
PORT             = ENV['PORT'] ? ENV['PORT'].to_i : 3000
SESSION_SECRET   = ENV['SESSION_SECRET'] || 'fallback_super_secure_secret_key'
USER_OAUTH_SCOPE = ['openid','email','profile']

def user_db
  @user_db ||= SQLite3::Database.new(DB_PATH)
end

enable :sessions
set :session_secret, SESSION_SECRET

# -------------------------------------------------
# Global in-memory structures
# -------------------------------------------------
scheduler = Rufus::Scheduler.new

# user_list_version for clients that want to poll user list changes
$user_list_version = 1
def bump_user_list_version
  $user_list_version += 1
end

# -------------------------------------------------
# Auth Guard
# -------------------------------------------------
before do
  protected_paths = [
    '/api/rooms',
    '/api/room_data',
    '/api/room_updates',
    '/api/events',
    '/api/create_event',
    '/api/update_event',
    '/api/delete_event'
  ]
  if protected_paths.include?(request.path_info)
    unless session[:user_email]
      halt 401, { error: 'Unauthorized' }.to_json
    end
  end
end

# -------------------------------------------------
# Load & Watch All Rooms on Startup
# -------------------------------------------------
Thread.new do
  sleep 3
  load_and_watch_all_rooms
end

# -------------------------------------------------
# Normal User OAuth Flow
# -------------------------------------------------
get '/login' do
  client_id  = Google::Auth::ClientId.from_file(CREDENTIALS_PATH)
  authorizer = Google::Auth::UserAuthorizer.new(client_id, USER_OAUTH_SCOPE, nil)

  auth_url = authorizer.get_authorization_url(
    base_url: REDIRECT_URI,
    state: 'user_auth'
  )
  redirect auth_url
end

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

    id_token = credentials.id_token
    if id_token.nil?
      return "Could not retrieve user info. Check scopes."
    end

    payload   = JSON.parse(Base64.decode64(id_token.split('.')[1]))
    email     = payload['email']
    full_name = payload['name']    rescue nil
    picture   = payload['picture'] rescue nil

    # Ensure users table
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

    row = user_db.execute("SELECT id FROM users WHERE email=?", [email]).first
    if row.nil?
      user_db.execute("INSERT INTO users (email, name, picture) VALUES (?, ?, ?)",
                      [email, full_name, picture])
      bump_user_list_version
    else
      user_db.execute("UPDATE users SET name=?, picture=? WHERE email=?",
                      [full_name, picture, email])
      bump_user_list_version
    end

    session[:user_email]   = email
    session[:user_name]    = full_name
    session[:user_picture] = picture

    redirect '/'
  else
    "Invalid state for user auth. Access denied."
  end
end

get '/logout' do
  session.clear
  redirect '/'
end

# -------------------------------------------------
# API: /api/me
# -------------------------------------------------
get '/api/me' do
  if session[:user_email]
    content_type :json
    {
      email:   session[:user_email],
      name:    session[:user_name],
      picture: session[:user_picture]
    }.to_json
  else
    halt 401, { error: 'Not logged in' }.to_json
  end
end

# -------------------------------------------------
# GET /api/all_users
# -------------------------------------------------
get '/api/all_users' do
  content_type :json
  rows = user_db.execute("SELECT email, name FROM users WHERE is_organizer = 0")
  users = rows.map do |row|
    { email: row[0], name: row[1] }
  end
  { users: users }.to_json
end

# -------------------------------------------------
# GET /api/user_updates
# -------------------------------------------------
get '/api/user_updates' do
  content_type :json
  { version: $user_list_version }.to_json
end

# -------------------------------------------------
# GET /api/user_details
# -------------------------------------------------
get '/api/user_details' do
  content_type :json
  email = params['email']
  halt 400, { error: 'Missing email param' }.to_json if !email || email.strip.empty?

  row = user_db.execute("SELECT email, name, picture FROM users WHERE email=?", [email]).first
  halt 404, { error: 'User not found' }.to_json unless row

  { email: row[0], name: row[1], picture: row[2] }.to_json
end

# -------------------------------------------------
# Webhook for Push Notifications from Google
# -------------------------------------------------
post '/notifications' do
  request_body = request.body.read
  headers = request.env.select { |k, _| k.start_with?('HTTP_') }

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
      $rooms_data[calendar_id][:events]       = updated_events
      $rooms_data[calendar_id][:last_fetched] = Time.now
    else
      $rooms_data[calendar_id] = {
        calendar_info: { id: calendar_id, summary: 'Unknown', description: '' },
        role: 'normal',
        sub_rooms: [],
        super_room: nil,
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
    events:        room_info[:events],
    last_fetched:  room_info[:last_fetched]
  }.to_json
end

get '/api/rooms' do
  rooms_array = $rooms_data.map do |cal_id, data|
    {
      id:          cal_id,
      summary:     data[:calendar_info][:summary],
      description: data[:calendar_info][:description]
    }
  end

  # Sort by 'order:N' in description if present
  sorted = rooms_array.sort_by do |room|
    match = room[:description].to_s.match(/order:(\d+)/)
    match ? match[1].to_i : Float::INFINITY
  end

  content_type :json
  { rooms: sorted }.to_json
end

# Fetch events directly from Google (optional)
get '/api/events' do
  content_type :json
  calendar_id = params['calendarId']
  halt 400, { error: 'Missing calendarId' }.to_json unless calendar_id

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials
  events = service.list_events(calendar_id, single_events: true, order_by: 'startTime')

  {
    events: events.items.map do |event|
      {
        id: event.id,
        title: event.summary,
        start: event.start.date_time || event.start.date,
        end:   event.end.date_time   || event.end.date,
        attendees: event.attendees&.map(&:email) || []
      }
    end
  }.to_json
end

# -------------------------------------------------
# Overlap Check
# -------------------------------------------------
def events_overlap?(calendar_id, start_time_utc, end_time_utc, ignore_event_id = nil)
  # This method checks for overlap with other *original* events (excluding linked events).
  # That ensures that normal events cannot overlap existing normal events,
  # but we do NOT treat linked events as blocking.
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

  events.items.any? do |ev|
    next false if ignore_event_id && ev.id == ignore_event_id
    # If this event is a "linked event," skip it from normal overlap checks
    priv = ev.extended_properties&.private
    is_linked = priv&.[]('is_linked') == 'true'
    next false if is_linked
    true
  end
end

# -------------------------------------------------
# CREATE EVENT
# -------------------------------------------------
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

  # Overlap check for the "original" event only (ignoring linked events).
  # If it fails, we abort. The frontend has already done an overlap check
  # with *all* events, but here on the backend we specifically exclude
  # linked events from blocking.
  if events_overlap?(calendar_id, start_time_utc, end_time_utc)
    halt 409, { error: 'Time slot overlaps an existing event' }.to_json
  end

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  attendees_emails = (participants + [creator_email]).uniq.reject(&:empty?)
  event = Google::Apis::CalendarV3::Event.new(
    summary: title,
    start:   { date_time: start_time_utc.iso8601, time_zone: 'UTC' },
    end:     { date_time: end_time_utc.iso8601,   time_zone: 'UTC' },
    attendees: attendees_emails.map { |em| { email: em } },
    extended_properties: {
      private: {
        creator_email:       creator_email,
        is_linked:           'false',  # original event
        original_calendar_id: calendar_id,  # points to itself
        original_event_id:   ''  # will fill in after creation
      }
    }
  )

  result = service.insert_event(calendar_id, event)

  # Fill in original_event_id for the newly created event
  event_id = result.id
  event.extended_properties.private['original_event_id'] = event_id
  service.update_event(calendar_id, event_id, event)

  # Update local data
  updated_events = fetch_events_for_calendar(calendar_id, service)
  if $rooms_data[calendar_id]
    $rooms_data[calendar_id][:events]       = updated_events
    $rooms_data[calendar_id][:last_fetched] = Time.now
  else
    $rooms_data[calendar_id] = {
      calendar_info: { id: calendar_id, summary: 'Unknown', description: '' },
      role: 'normal',
      sub_rooms: [],
      super_room: nil,
      events:        updated_events,
      last_fetched:  Time.now
    }
  end
  $room_update_tracker[calendar_id] += 1

  # If the room is super or sub, create the linked events without overlap checks
  create_linked_events_if_needed(
    calendar_id, 
    event_id, 
    start_time_utc, 
    end_time_utc, 
    title, 
    attendees_emails, 
    creator_email, 
    service
  )

  content_type :json
  {
    event_id:  event_id,
    summary:   result.summary,
    start:     result.start.date_time || result.start.date,
    end:       result.end.date_time   || result.end.date,
    attendees: result.attendees&.map(&:email) || [],
    organizer: creator_email,
    status:    'success'
  }.to_json
end

# -------------------------------------------------
# Helper: create linked events if room is super or sub
# -------------------------------------------------
def create_linked_events_if_needed(original_cal_id, original_event_id, start_time, end_time, title, attendees, creator_email, service)
  room_data = $rooms_data[original_cal_id]
  return unless room_data # safety

  role = room_data[:role]
  case role
  when 'super'
    # If super => create linked events in each sub room
    sub_names = room_data[:sub_rooms] || []
    sub_names.each do |sub_name|
      sub_cal_id = find_calendar_id_by_summary(sub_name)
      next unless sub_cal_id

      create_linked_event(
        original_cal_id, 
        original_event_id, 
        sub_cal_id, 
        start_time, 
        end_time, 
        title, 
        attendees, 
        creator_email, 
        service
      )
    end

  when 'sub'
    # If sub => create linked event in the super
    super_name = room_data[:super_room]
    if super_name && !super_name.empty?
      super_cal_id = find_calendar_id_by_summary(super_name)
      if super_cal_id
        create_linked_event(
          original_cal_id,
          original_event_id,
          super_cal_id,
          start_time,
          end_time,
          title,
          attendees,
          creator_email,
          service
        )
      end
    end
  else
    # normal => do nothing
  end
end

def create_linked_event(original_cal_id, original_event_id, linked_cal_id, start_time, end_time, title, attendees, creator_email, service)
  # IMPORTANT: No overlap check for linked events
  event = Google::Apis::CalendarV3::Event.new(
    summary: title,
    start:   { date_time: start_time.iso8601, time_zone: 'UTC' },
    end:     { date_time: end_time.iso8601,   time_zone: 'UTC' },
    attendees: attendees.map { |em| { email: em } },
    extended_properties: {
      private: {
        creator_email:       creator_email,
        is_linked:           'true',
        original_calendar_id: original_cal_id,
        original_event_id:   original_event_id
      }
    }
  )
  result = service.insert_event(linked_cal_id, event)
  # Refresh memory
  updated_events = fetch_events_for_calendar(linked_cal_id, service)
  if $rooms_data[linked_cal_id]
    $rooms_data[linked_cal_id][:events]       = updated_events
    $rooms_data[linked_cal_id][:last_fetched] = Time.now
    $room_update_tracker[linked_cal_id] += 1
  end
  result
end

def find_calendar_id_by_summary(summary_name)
  $rooms_data.each do |cal_id, data|
    return cal_id if data[:calendar_info][:summary] == summary_name
  end
  nil
end

# -------------------------------------------------
# UPDATE EVENT
# -------------------------------------------------
put '/api/update_event' do
  request_data   = JSON.parse(request.body.read)
  calendar_id    = request_data['calendarId']
  event_id       = request_data['eventId']
  title          = request_data['title']
  participants   = request_data['participants'] || []

  halt 400, { error: 'Missing fields' }.to_json unless calendar_id && event_id && title

  user_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless user_email

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  existing_event = service.get_event(calendar_id, event_id)
  priv_props     = existing_event.extended_properties&.private || {}
  is_linked      = (priv_props['is_linked'] == 'true')

  # If event is linked => do NOT allow direct edit
  if is_linked
    halt 403, { error: 'Cannot edit a linked event directly. Edit the original event.' }.to_json
  end

  all_attendees  = (existing_event.attendees || []).map(&:email)
  creator_email  = priv_props['creator_email']

  unless all_attendees.include?(user_email) || (creator_email == user_email)
    halt 403, { error: 'You do not have permission to update this event' }.to_json
  end

  # We do NOT allow time changes in this endpoint, so we skip overlap checks entirely.
  updated_attendees_emails = (participants + [creator_email]).uniq.reject(&:empty?)
  existing_event.summary   = title
  existing_event.attendees = updated_attendees_emails.map { |em| { email: em } }

  result = service.update_event(calendar_id, event_id, existing_event)

  # Also update linked events (same summary, same attendees)
  sync_linked_events(calendar_id, event_id, title, updated_attendees_emails, service)

  updated_events = fetch_events_for_calendar(calendar_id, service)
  if $rooms_data[calendar_id]
    $rooms_data[calendar_id][:events]       = updated_events
    $rooms_data[calendar_id][:last_fetched] = Time.now
  end
  $room_update_tracker[calendar_id] += 1

  content_type :json
  {
    event_id:  result.id,
    summary:   result.summary,
    start:     result.start.date_time || result.start.date,
    end:       result.end.date_time   || result.end.date,
    attendees: result.attendees&.map(&:email) || [],
    organizer: creator_email,
    status:    'success'
  }.to_json
end

def sync_linked_events(original_cal_id, original_event_id, new_title, new_attendees, service)
  # For each known calendar, if we find an event with
  #   extended_properties.private.is_linked = 'true'
  #   original_calendar_id == original_cal_id
  #   original_event_id == original_event_id
  # => update that event's summary and attendees.
  $rooms_data.keys.each do |cal_id|
    # skip the original
    next if cal_id == original_cal_id

    events = service.list_events(
      cal_id,
      single_events: true,
      order_by: 'startTime',
      max_results: 2500
    )
    events.items.each do |ev|
      priv = ev.extended_properties&.private
      next unless priv
      next unless priv['is_linked'] == 'true'
      next unless priv['original_calendar_id'] == original_cal_id
      next unless priv['original_event_id']   == original_event_id

      ev.summary   = new_title
      ev.attendees = new_attendees.map { |em| { email: em } }
      service.update_event(cal_id, ev.id, ev)

      updated_sub_events = fetch_events_for_calendar(cal_id, service)
      $rooms_data[cal_id][:events]       = updated_sub_events
      $rooms_data[cal_id][:last_fetched] = Time.now
      $room_update_tracker[cal_id] += 1
    end
  end
end

# -------------------------------------------------
# DELETE EVENT
# -------------------------------------------------
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
  priv  = event.extended_properties&.private
  is_linked = (priv&.[]('is_linked') == 'true')
  creator_email = priv&.[]('creator_email')

  # If event is linked => do NOT allow direct delete
  if is_linked
    halt 403, { error: 'Cannot delete a linked event directly. Delete the original event.' }.to_json
  end

  all_attendees = (event.attendees || []).map(&:email)
  unless all_attendees.include?(user_email) || (creator_email == user_email)
    halt 403, { error: 'You do not have permission to delete this event' }.to_json
  end

  service.delete_event(calendar_id, event_id)

  updated_events = fetch_events_for_calendar(calendar_id, service)
  if $rooms_data[calendar_id]
    $rooms_data[calendar_id][:events]       = updated_events
    $rooms_data[calendar_id][:last_fetched] = Time.now
  end
  $room_update_tracker[calendar_id] += 1

  # Also delete linked events
  delete_linked_events(calendar_id, event_id, service)

  content_type :json
  { status: 'success' }.to_json
end

def delete_linked_events(original_cal_id, original_event_id, service)
  # For each other calendar, remove events that are linked copies of the original
  $rooms_data.keys.each do |cal_id|
    next if cal_id == original_cal_id
    events = service.list_events(
      cal_id,
      single_events: true,
      order_by: 'startTime',
      max_results: 2500
    )
    events.items.each do |ev|
      priv = ev.extended_properties&.private
      next unless priv
      next unless priv['is_linked'] == 'true'
      next unless priv['original_calendar_id'] == original_cal_id
      next unless priv['original_event_id']   == original_event_id

      service.delete_event(cal_id, ev.id)
      updated_sub = fetch_events_for_calendar(cal_id, service)
      $rooms_data[cal_id][:events]       = updated_sub
      $rooms_data[cal_id][:last_fetched] = Time.now
      $room_update_tracker[cal_id] += 1
    end
  end
end

# -------------------------------------------------
# Scheduler to Renew Watches
# -------------------------------------------------
scheduler.every '23h' do
  begin
    puts 'Renewing watches for all room calendars...'
    refresh_room_calendars
  rescue => e
    puts "Error renewing watches: #{e.message}"
  end
end

# -------------------------------------------------
# Serve the Frontend
# -------------------------------------------------
get '/' do
  send_file File.join(settings.public_folder, 'index.html')
end

set :environment, :production
set :port, PORT
