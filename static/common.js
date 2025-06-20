'use strict'

function log(str) {
    var node = document.createElement("div")
    node.textContent = str
    logs.appendChild(node)
}
window.addEventListener("error", function (event) {
    log(event.filename + ":" + event.lineno + " " + event.message)
}, false)

var isIOS = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function getCookies() {
	var cookieRegex = /([\w\.]+)\s*=\s*(?:"((?:\\"|[^"])*)"|(.*?))\s*(?:[;,]|$)/g
	var cookies = {}
	var match
	while( (match = cookieRegex.exec(document.cookie)) !== null ) {
		var value = match[2] || match[3]
		cookies[match[1]] = decodeURIComponent(value)
		try {
			cookies[match[1]] = JSON.parse(cookies[match[1]])
		} catch (err) {}
	}
	return cookies
}