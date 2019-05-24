## Simple HTTP/2 Proxy for testing purposes

Runs hard coded on port 0.0.0.0:3000

Understands CONNECT to create tunnels and forwards any other type of request (GET/POST.)  POST is untested.

The certificate is issued for 'localhost' and 'foo.example.org' CNs.
