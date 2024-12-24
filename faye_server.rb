gem 'rack', '~> 2.2.10'
require 'faye'
require 'rack/handler/webrick'
require 'webrick'

faye_server = Faye::RackAdapter.new(mount: '/faye', timeout: 45)
Rack::Handler::WEBrick.run(faye_server, Port: 9292)
puts "Faye server running on http://localhost:9292/faye"
