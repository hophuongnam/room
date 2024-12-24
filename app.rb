require 'sinatra'
require 'google/apis/calendar_v3'
require 'rufus-scheduler'
require 'json'
require_relative 'services'

# -------------------------------------------------
# Global Scheduler
# -------------------------------------------------
scheduler = Rufus::Scheduler.new

# Enable sessions with a secure secret
enable :sessions
set :session_secret, ENV['SESSION_SECRET'] || 'fallback_super_secure_secret_key'

# -------------------------------------------------
# 1) On Server Start, Load All Rooms & Set Up Watches
# -------------------------------------------------
# We do this when the file is loaded, so it runs once at startup.
Thread.new do
  # Small delay to ensure Sinatra has started
  sleep 3
  load_and_watch_all_rooms
end

# -------------------------------------------------
# 2) Webhook to handle push notifications
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
    # Fetch the updated events from Google
    service = Google::Apis::CalendarV3::CalendarService.new
    service.authorization = load_organizer_credentials

    updated_events = fetch_events_for_calendar(calendar_id, service)

    # Update the in-memory cache
    if $rooms_data[calendar_id]
      $rooms_data[calendar_id][:events] = updated_events
      $rooms_data[calendar_id][:last_fetched] = Time.now
    else
      # If for some reason we never cached it before, create a new entry
      $rooms_data[calendar_id] = {
        calendar_info: { id: calendar_id, summary: 'Unknown', description: '' },
        events: updated_events,
        last_fetched: Time.now
      }
    end

    # Mark that the room has changed
    $room_update_tracker[calendar_id] += 1

  when 'deleted'
    # Typically means the channel was invalidated or the calendar was removed
    puts "Channel/resource deleted: #{resource_id}"
    $calendar_watch_map.delete(resource_id)
  else
    puts "Unhandled resource state: #{resource_state}"
  end

  status 200
end

# -------------------------------------------------
# 3) Endpoint for Client to Know Which Rooms Changed
# -------------------------------------------------
# Basic approach: client can poll /api/room_updates with a lastKnownVersion
# for each calendar, or you can return all calendars that changed
#
# For simplicity, we'll return a list of { calendarId, version } for each room
# so the client can see if the version is higher than what it has.
get '/api/room_updates' do
  content_type :json
  # Return the entire set of "versions" so the client can compare
  # e.g. [ { roomId: 'calendar@...', version: 2 }, ... ]
  updates = $room_update_tracker.map do |cal_id, ver|
    { roomId: cal_id, version: ver }
  end
  { updates: updates }.to_json
end

# -------------------------------------------------
# 4) Client requests updated room data
# -------------------------------------------------
# The client will call /api/room_data?calendarId=xxx
# and we'll return the in-memory cached events for that room.
get '/api/room_data' do
  calendar_id = params['calendarId']
  halt 400, { error: 'Missing calendarId' }.to_json unless calendar_id

  room_info = $rooms_data[calendar_id]
  halt 404, { error: 'Room not found' }.to_json unless room_info

  content_type :json
  {
    calendar_info: room_info[:calendar_info],
    events: room_info[:events],
    last_fetched: room_info[:last_fetched]
  }.to_json
end

# -------------------------------------------------
# 5) Existing/Standard Routes (Create, List, Delete)
# -------------------------------------------------
get '/' do
  send_file File.join(settings.public_folder, 'index.html')
end

# This route lists the "room" calendars. But we already have them in memory.
# We'll return what's in $rooms_data for consistency.
get '/api/rooms' do
  # Convert $rooms_data to an array of [calendar_id, { ... }] then map
  rooms_array = $rooms_data.map do |cal_id, data|
    {
      id: cal_id,
      summary: data[:calendar_info][:summary],
      description: data[:calendar_info][:description]
    }
  end
  # Sort if needed, e.g., by some "order" in description
  sorted = rooms_array.sort_by do |room|
    match = room[:description].to_s.match(/order:(\d+)/)
    match ? match[1].to_i : Float::INFINITY
  end

  content_type :json
  { rooms: sorted }.to_json
end

# We won't rely on /api/events anymore in the client,
# because we have /api/room_data returning the cached events.
# But let's keep it for completeness—this fetches direct from Google.
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

# Create event in Google
post '/api/create_event' do
  request_data = JSON.parse(request.body.read)
  calendar_id  = request_data['calendarId']
  title        = request_data['title']
  start_time   = request_data['start']
  end_time     = request_data['end']
  participants = request_data['participants'] || []

  halt 400, { error: 'Missing required fields' }.to_json unless calendar_id && title && start_time && end_time

  creator_email = session[:user_email]
  halt 401, { error: 'Unauthorized' }.to_json unless creator_email

  attendees = (participants + [creator_email]).uniq.reject(&:empty?).map { |email| { email: email } }

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  event = Google::Apis::CalendarV3::Event.new(
    summary: title,
    start: { date_time: start_time, time_zone: 'UTC' },
    end:   { date_time: end_time, time_zone: 'UTC' },
    attendees: attendees
  )

  result = service.insert_event(calendar_id, event)
  content_type :json
  { event_id: result.id, status: 'success' }.to_json
end

# Delete event
delete '/api/delete_event' do
  request_data = JSON.parse(request.body.read)
  calendar_id  = request_data['calendarId']
  event_id     = request_data['id']

  halt 400, { error: 'Missing required fields' }.to_json unless calendar_id && event_id

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials
  service.delete_event(calendar_id, event_id)

  content_type :json
  { status: 'success' }.to_json
end

# -------------------------------------------------
# 6) Scheduler to Renew Watches (every 23 hours)
# -------------------------------------------------
scheduler.every '23h' do
  begin
    puts 'Renewing watches for all room calendars...'
    refresh_room_calendars
  rescue => e
    puts "Error renewing watches: #{e.message}"
  end
end

# Sinatra settings
set :environment, :production
set :port, 3000
