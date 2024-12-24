require 'sinatra'
require 'google/apis/calendar_v3'
require 'rufus-scheduler'
require 'faye/websocket'
require_relative 'services'

connections = []
scheduler = Rufus::Scheduler.new
@active_watches = [] # Track active watches

# Enable sessions with a secure secret
enable :sessions
set :session_secret, ENV['SESSION_SECRET'] || 'fallback_super_secure_secret_key'

# Webhook to handle notifications
post '/notifications' do
  request_body = request.body.read
  headers = request.env.select { |k, _| k.start_with?('HTTP_') }

  puts "Notification Headers: #{headers.inspect}"
  puts "Notification Body: #{request_body}"

  resource_id = headers['HTTP_X_GOOG_RESOURCE_ID']
  resource_state = headers['HTTP_X_GOOG_RESOURCE_STATE']

  if resource_state == 'sync' || resource_state == 'exists'
    puts "Processing notification for resource state: #{resource_state}, resource ID: #{resource_id}"
    # Broadcast event update notification
    connections.each do |ws|
      ws.send({ type: 'event_update', resource_id: resource_id }.to_json)
    end
  else
    puts "Unhandled resource state: #{resource_state}"
  end

  status 200
end

# WebSocket endpoint for client updates
get '/updates' do
  if Faye::WebSocket.websocket?(request.env)
    ws = Faye::WebSocket.new(request.env)

    ws.on :open do |event|
      connections << ws
      puts "WebSocket connection opened"
    end

    ws.on :close do |event|
      connections.delete(ws)
      puts "WebSocket connection closed"
    end

    ws.rack_response
  else
    halt 400, 'WebSocket required'
  end
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

  # Sort the calendars by the extracted order value
  sorted_rooms = room_calendars.sort_by do |cal|
    # Extract the order number from the description (default to a high number if not present)
    match = cal.description.match(/order:(\d+)/)
    match ? match[1].to_i : Float::INFINITY
  end

  content_type :json
  { rooms: sorted_rooms.map { |cal| { id: cal.id, summary: cal.summary, description: cal.description } } }.to_json
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

  # Broadcast WebSocket update
  connections.each do |ws|
    ws.send({ type: 'event_created', event: result.to_h }.to_json)
  end

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

# Scheduler for renewing watches
scheduler.every '23h' do
  begin
    puts 'Renewing watches for all room calendars...'
    refresh_room_calendars
  rescue => e
    puts "Error renewing watches: #{e.message}"
  end
end

# Ensure unique watch setup
def setup_watch(calendar_id)
  return if @active_watches.include?(calendar_id)

  service = Google::Apis::CalendarV3::CalendarService.new
  service.authorization = load_organizer_credentials

  channel = Google::Apis::CalendarV3::Channel.new(
    id: SecureRandom.uuid,
    type: 'webhook',
    address: 'https://room.mefat.review/notifications'
  )

  service.watch_event(calendar_id, channel)
  @active_watches << calendar_id
  puts "Watch set up for calendar: #{calendar_id}"
end

# Set up initial watch for calendar list
setup_calendar_list_watch

set :environment, :production
set :port, 3000
