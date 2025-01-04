# app.rb
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

# ---------------------------
# NEW: Global token usable flag
# ---------------------------
# If this is ever set to false, it means the Organizer's
# Google credentials are no longer valid/usable.
$token_usable = true

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
  # If the organizer's token became invalid, block all requests
  unless $token_usable
    halt 403, { error: 'Organizer credentials invalid. Please re-authenticate.' }.to_json
  end

  protected_paths = [
    '/api/rooms',
    '/api/room_data',
    '/api/room_updates',
    '/api/events',
    '/api/create_event',
    '/api/update_event',
    '/api/delete_event',
    '/api/all_users',
    '/api/user_updates',
    '/api/user_details',
    '/api/freebusy'  # also protect freebusy
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
        id:          event.id,
        title:       event.summary,
        start:       event.start.date_time || event.start.date,
        end:         event.end.date_time   || event.end.date,
        attendees:   event.attendees&.map(&:email) || [],
        location:    event.location,
        description: event.description || ""
      }
    end
  }.to_json
end

# -------------------------------------------------
# Overlap Check
# -------------------------------------------------
def events_overlap?(calendar_id, start_time_utc, end_time_utc, ignore_event_id = nil)
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

    is_linked = false
    if ev.extended_properties && ev.extended_properties.private
      is_linked = (ev.extended_properties.private['is_linked'] == 'true')
    end

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
  description    = request_data['description'] || ""

  halt 400, { error: 'Missing fields' }.to_json unless calendar_id && title && start_time_str && end_time_str

  creator_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless creator_email

  start_time_utc = Time.parse(start_time_str).utc
  end_time_utc   = Time.parse(end_time_str).utc

  # Overlap check for original event only
  if events_overlap?(calendar_id, start_time_utc, end_time_utc)
    halt 409, { error: 'Time slot overlaps an existing event' }.to_json
  end

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  attendees_emails = (participants + [creator_email]).uniq.reject(&:empty?)

  # The room's name for the main event
  calendar_name = $rooms_data[calendar_id][:calendar_info][:summary] rescue 'Unknown Room'

  extended_props = Google::Apis::CalendarV3::Event::ExtendedProperties.new(
    private: {
      'creator_email'        => creator_email,
      'is_linked'            => 'false',
      'original_calendar_id' => calendar_id,
      'original_event_id'    => ''  # will fill in after creation
    }
  )

  event = Google::Apis::CalendarV3::Event.new(
    summary:     title,
    location:    calendar_name,
    description: description,
    start:       { date_time: start_time_utc.iso8601, time_zone: 'UTC' },
    end:         { date_time: end_time_utc.iso8601,   time_zone: 'UTC' },
    attendees:   attendees_emails.map { |em| { email: em } },
    extended_properties: extended_props
  )

  result = service.insert_event(calendar_id, event)

  # Fill in original_event_id after creation
  event_id = result.id
  event.extended_properties.private['original_event_id'] = event_id

  # Update event with the new original_event_id
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

  # Create linked events if needed
  create_linked_events_if_needed(
    calendar_id,
    event_id,
    start_time_utc,
    end_time_utc,
    title,
    attendees_emails,
    creator_email,
    service,
    description
  )

  content_type :json
  {
    event_id:    event_id,
    summary:     result.summary,
    start:       result.start.date_time || result.start.date,
    end:         result.end.date_time   || result.end.date,
    attendees:   result.attendees&.map(&:email) || [],
    location:    result.location,
    organizer:   creator_email,
    description: description,
    status:      'success'
  }.to_json
end

def create_linked_events_if_needed(original_cal_id, original_event_id, start_time, end_time, title, attendees, creator_email, service, description)
  room_data = $rooms_data[original_cal_id]
  return unless room_data

  role = room_data[:role]
  case role
  when 'super'
    # If super => create linked events in sub rooms
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
        service,
        description
      )
    end

  when 'sub'
    # If sub => create linked event in super
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
          service,
          description
        )
      end
    end
  else
    # normal => do nothing
  end
end

def create_linked_event(original_cal_id, original_event_id, linked_cal_id, start_time, end_time, title, attendees, creator_email, service, description)
  linked_name = $rooms_data[linked_cal_id][:calendar_info][:summary] rescue 'Linked Room'

  link_props = Google::Apis::CalendarV3::Event::ExtendedProperties.new(
    private: {
      'creator_email'        => creator_email,
      'is_linked'            => 'true',
      'original_calendar_id' => original_cal_id,
      'original_event_id'    => original_event_id
    }
  )
  event = Google::Apis::CalendarV3::Event.new(
    summary:     title,
    location:    linked_name,
    description: description,
    start:       { date_time: start_time.iso8601, time_zone: 'UTC' },
    end:         { date_time: end_time.iso8601,   time_zone: 'UTC' },
    attendees:   attendees.map { |em| { email: em } },
    extended_properties: link_props
  )
  service.insert_event(linked_cal_id, event)

  # Refresh memory
  updated_events = fetch_events_for_calendar(linked_cal_id, service)
  if $rooms_data[linked_cal_id]
    $rooms_data[linked_cal_id][:events]       = updated_events
    $rooms_data[linked_cal_id][:last_fetched] = Time.now
    $room_update_tracker[linked_cal_id] += 1
  end
end

def find_calendar_id_by_summary(summary_name)
  $rooms_data.each do |cal_id, data|
    return cal_id if data[:calendar_info][:summary] == summary_name
  end
  nil
end

# -------------------------------------------------
# UPDATE EVENT (now allows time changes)
# -------------------------------------------------
put '/api/update_event' do
  request_data   = JSON.parse(request.body.read)
  calendar_id    = request_data['calendarId']
  event_id       = request_data['eventId']
  title          = request_data['title']
  participants   = request_data['participants'] || []
  description    = request_data['description'] || ""

  # Optional new start/end for time changes
  new_start_time_str = request_data['start']
  new_end_time_str   = request_data['end']

  halt 400, { error: 'Missing fields' }.to_json unless calendar_id && event_id && title

  user_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless user_email

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  existing_event = service.get_event(calendar_id, event_id)

  priv_props = if existing_event.extended_properties&.private
                 existing_event.extended_properties.private
               else
                 {}
               end

  is_linked     = (priv_props['is_linked'] == 'true')
  creator_email = priv_props['creator_email']

  if is_linked
    halt 403, { error: 'Cannot edit a linked event directly. Edit the original event.' }.to_json
  end

  all_attendees = (existing_event.attendees || []).map(&:email)
  unless all_attendees.include?(user_email) || (creator_email == user_email)
    halt 403, { error: 'You do not have permission to update this event' }.to_json
  end

  # Update time if provided
  if new_start_time_str && new_end_time_str
    start_time_utc = Time.parse(new_start_time_str).utc
    end_time_utc   = Time.parse(new_end_time_str).utc

    # Overlap check
    if events_overlap?(calendar_id, start_time_utc, end_time_utc, event_id)
      halt 409, { error: 'Time slot overlaps an existing event' }.to_json
    end

    existing_event.start.date_time = start_time_utc.iso8601
    existing_event.end.date_time   = end_time_utc.iso8601
  end

  updated_attendees_emails = (participants + [creator_email]).uniq.reject(&:empty?)
  existing_event.summary     = title
  existing_event.description = description
  existing_event.attendees   = updated_attendees_emails.map { |em| { email: em } }

  # Keep the location updated as well
  new_location = $rooms_data[calendar_id][:calendar_info][:summary] rescue 'Updated Room'
  existing_event.location = new_location

  result = service.update_event(calendar_id, event_id, existing_event)
  sync_linked_events(calendar_id, event_id, result.summary, updated_attendees_emails, result.location, service, description)

  updated_events = fetch_events_for_calendar(calendar_id, service)
  if $rooms_data[calendar_id]
    $rooms_data[calendar_id][:events]       = updated_events
    $rooms_data[calendar_id][:last_fetched] = Time.now
  end
  $room_update_tracker[calendar_id] += 1

  content_type :json
  {
    event_id:    result.id,
    summary:     result.summary,
    start:       result.start.date_time || result.start.date,
    end:         result.end.date_time   || result.end.date,
    attendees:   result.attendees&.map(&:email) || [],
    location:    result.location,
    organizer:   creator_email,
    description: result.description || "",
    status:      'success'
  }.to_json
end

def sync_linked_events(original_cal_id, original_event_id, new_title, new_attendees, new_location, service, description)
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

      ev.summary     = new_title
      ev.attendees   = new_attendees.map { |em| { email: em } }
      ev.location    = $rooms_data[cal_id][:calendar_info][:summary] rescue new_location
      ev.description = description

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

  priv = if event.extended_properties&.private
           event.extended_properties.private
         else
           {}
         end

  is_linked     = (priv['is_linked'] == 'true')
  creator_email = priv['creator_email']

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
# NEW: FREE/BUSY ROUTE
# -------------------------------------------------
post '/api/freebusy' do
  content_type :json

  data = JSON.parse(request.body.read)
  start_str = data['start']
  end_str   = data['end']
  attendee_list = data['attendees'] || []

  if !start_str || !end_str || attendee_list.empty?
    halt 400, { error: 'Missing start/end/attendees.' }.to_json
  end

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  request_obj = Google::Apis::CalendarV3::FreeBusyRequest.new(
    time_min: Time.parse(start_str).utc.iso8601,
    time_max: Time.parse(end_str).utc.iso8601,
    items: attendee_list.map { |id| { id: id } }
  )

  resp = service.query_freebusy(request_obj)

  # Build a simple structure showing the busy intervals
  results = {}
  resp.calendars.each do |cal_id, freebusy_cal|
    busy = freebusy_cal.busy || []
    results[cal_id] = busy.map { |b| { start: b.start, end: b.end } }
  end

  { freebusy: results }.to_json
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
