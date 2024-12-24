require 'faye'
require 'rack/handler/thin'
require 'logger'

# Initialize logger
logger = Logger.new($stdout)
logger.level = Logger::INFO

# Initialize Faye server
faye_server = Faye::RackAdapter.new(mount: '/faye', timeout: 45)

# Add logging for publish events
faye_server.bind(:publish) do |client_id, channel, data|
  logger.info("Message Published: Client ID=#{client_id}, Channel=#{channel}, Data=#{data}")
end

# Start the server
Rack::Handler::Thin.run(
  faye_server,
  Host: '0.0.0.0', # Listen on all network interfaces
  Port: 9292,
  Threads: "4:16"
)

logger.info("Faye server running on http://0.0.0.0:9292/faye")
