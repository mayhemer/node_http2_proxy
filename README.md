## Simple HTTP/2 Proxy for testing purposes

**This is not production quality at all!  Don't use in production environments!**

Runs hard coded on `0.0.0.0:3000`.

Understands `CONNECT` to create tunnels and forwards any other type of request (GET/POST.)

Allows 'blind' (a.k.a any password will do) authentication for testing how clients handle 407 responses.

The server certificate is issued for:
* DNS Name: `localhost`
* DNS Name: `foo.example.com`
* DNS Name: `alt1.example.com`
* DNS Name: `alt2.example.com`
