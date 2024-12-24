require 'faye'
require 'rack/handler/puma'

faye_server = Faye::RackAdapter.new(mount: '/faye', timeout: 45)
Rack::Handler::Puma.run(faye_server, Port: 9292)
puts "Faye server running on http://localhost:9292/faye"
