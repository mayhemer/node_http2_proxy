# Simple HTTP/2 Proxy

This software is intended for HTTP client developers to test their code with an HTTP/2 proxy.  This is not a production quality, but in time has proven as capable and reliable.  
* Understands `CONNECT` to create tunnels to HTTPS/1/2 end-points.  
* Capable to connect and relay to plain HTTP end-points as well.
* ALPN other than 'HTTP/2' (`unknownProtocol`) is supported and handled internally by double-proxying to a plain HTTP/1 proxy.
* Allows 'blind' (a.k.a any-password-will-do) optional configurable authentication for testing how clients handle 407 responses.

**Works best with Node v12.4.0.**

## Installation ##
* clone the repository, `cd` into it
* run `npm install`
* run `node proxy.js`

After this setup the proxy runs (hard coded) on `0.0.0.0:3000`.

## Client side setup ##
* In the borwser (Firefox) or the system (for e.g. Chrome) install `http2-ca.pem` as a trusted certification authority for server identification
* Setup the browser or the system to use Proxy Auto Configuration (PAC) script URL using either of:
  * a `data:` url:
    ```javascript
    data:text/javascript,function FindProxyForURL() { return "HTTPS localhost:3000"; }
    ```
  * or a PAC file with this content (served on a server or via a `file:` url):
    ```javascript
    function FindProxyForURL(url, host) {
        return "HTTPS localhost:3000";
    }
    ```

### Notes
The server certificate (`http2-cert.pem`) is issued for:
* DNS Name: `localhost`
* DNS Name: `foo.example.com`
* DNS Name: `alt1.example.com`
* DNS Name: `alt2.example.com`
