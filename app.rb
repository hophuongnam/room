require 'sinatra'
require 'google/apis/calendar_v3'
require 'rufus-scheduler'
require 'net/http'
require 'uri'
require 'json'
require_relative 'services'

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

  case resource_state
  when 'sync', 'exists', 'updated'
    puts "Processing event update for resource ID: #{resource_id}"
  when 'deleted'
    puts "Processing event deletion for resource ID: #{resource_id}"
  else
    puts "Unhandled resource state: #{resource_state}"
  end

  status 200
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
        title: event.summary,
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

# Scheduler for renewing watches
scheduler.every '23h' do
  begin
    puts 'Renewing watches for all room calendars...'
    refresh_room_calendars
  rescue => e
    puts "Error renewing watches: #{e.message}"
  end
end

setup_calendar_list_watch

set :environment, :production
set :port, 3000
