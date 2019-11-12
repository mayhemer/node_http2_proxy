# Simple HTTP/2 Proxy

This software is intended for HTTP client developers to test their code with an HTTP/2 proxy.  This is not a production quality, but in time has proven as capable and reliable.  
* Understands `CONNECT` to create tunnels to HTTPS/1/2 end-points.  
* Capable to connect and relay to plain HTTP end-points as well.
* Extended Connect Protocol (RFC 8441) is supported, but can be turned off to handle `unknownProtocol` with double-proxying through an internal plain HTTP/1 proxy.
* Allows 'blind' (a.k.a any-password-will-do) optional configurable authentication for testing how clients handle 407 responses.
* Can be controlled at runtime through `http://the.proxy/` interface, supporting:
  * `http://the.proxy/fail?CODE` to make all requests fail with the HTTP response `CODE` number.  Passing `CODE` = 0 reverts to normal behavior.

**Tested most successfully with Node 12.4.0+**
**Minimum Node version to run this on is 10**

## Installation ##
* clone the repository, `cd` into it
* run `npm install`
* run `npm start`

After this setup the HTTP/2 (over TLS) proxy runs (hard coded) on `0.0.0.0:3000`.
Note that there is also a plain HTTP/1 proxy on `127.0.0.1:3001`, which is used for handling (pipe) 'unknown protocol' coming to the h2 proxy when `"enableConnectProtocol"` config option is left `false`.  

If you need to test against secured (TLS'ed) HTTPS/1 proxy, flip `"http1_secured"` config option to `true`.  Then instead of an HTTP/2 proxy you will have HTTPS/1 proxy on the same port `3000`.  It's using the same certificate as the h2 proxy.  Client setup (as below) remains the same.

## Client side setup ##
* In the browser (Firefox) or the system (for e.g. Chrome) install `http2-ca.pem` as a trusted certification authority for server identification
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
