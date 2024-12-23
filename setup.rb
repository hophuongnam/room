require 'google/apis/calendar_v3'
require 'googleauth'
require 'sqlite3'
require 'json'
require 'sinatra'
require 'base64'

APPLICATION_NAME = 'Meeting Room Reservation System'
CREDENTIALS_PATH = 'credentials.json'
DB_PATH = 'users.db'
REDIRECT_URI = "http://localhost:3000/oauth2callback"
PORT = 3000
SCOPE = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'openid',
  'email',
  'profile'
]

# Initialize the SQLite database
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

def save_organizer_credentials(db, email, credentials)
  expiry_time = credentials.expiry.is_a?(Integer) ? Time.now + credentials.expiry : credentials.expiry

  serialized_credentials = JSON.dump({
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    scope: credentials.scope,
    expiry: expiry_time.iso8601, # Ensure expiry is stored as a string
    redirect_uri: REDIRECT_URI
  })

  db.execute("INSERT OR REPLACE INTO users (email, is_organizer, credentials) VALUES (?, ?, ?)",
             [email, 1, serialized_credentials])
end

# OAuth callback endpoint
get '/oauth2callback' do
  code = params['code']
  state = params['state']

  if state != 'setup_organizer'
    return "Invalid state for setup. Access denied."
  end

  client_id = Google::Auth::ClientId.from_file(CREDENTIALS_PATH)
  authorizer = Google::Auth::UserAuthorizer.new(client_id, SCOPE, nil)

  credentials = authorizer.get_credentials_from_code(
    user_id: 'organizer', code: code, base_url: REDIRECT_URI
  )

  # Extract email from ID token
  id_token = credentials.id_token
  email = nil
  if id_token
    payload = JSON.parse(Base64.decode64(id_token.split('.')[1]))
    email = payload['email']
  end

  # Ensure email is present
  raise "Unable to retrieve email from ID token. Check OAuth scopes." if email.nil?

  # Save organizer credentials
  db = initialize_database
  save_organizer_credentials(db, email, credentials)

  "Setup complete! Organizer authenticated with email: #{email}."
end

# Main Setup Script
client_id = Google::Auth::ClientId.from_file(CREDENTIALS_PATH)
authorizer = Google::Auth::UserAuthorizer.new(client_id, SCOPE, nil)

authorization_url = authorizer.get_authorization_url(base_url: REDIRECT_URI, state: 'setup_organizer')

set :port, PORT
puts "Please visit the following URL to authenticate the organizer:"
puts authorization_url

Sinatra::Application.run!
