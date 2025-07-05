let socket;
let reconnectInterval = 1000; // 1 second

const el = (cls) => document.querySelector(`.${cls}`);
const q = (sel) => document.querySelectorAll(sel);

function connect() {
    socket = new WebSocket(`ws://${window.location.host}/ws`);

    socket.onopen = function() {
        console.log("WebSocket connected");
    };

    socket.onmessage = function(event) {
        let msg = JSON.parse(event.data);
        if (msg["DiscoveredClients"] !== undefined) {
            let text = "";
            for (let addrs of msg["DiscoveredClients"].clients) {
                text += `<p class="client-cont">`;
                for (let addr of addrs) {
                    text += `<span class="addr">${addr}</span>`;
                    text += `<button class="btn connect-btn" data-addr=${addr}>Connect</button>`;
                    text += `<br/>`;
                }
                text += `</p>`;
            }
            el("discovered-clients").innerHTML = text;
            for (let el of q(".discovered-clients .connect-btn")) {
                el.addEventListener("click", function() {
                    let addr = el.dataset.addr;
                    ws_send(JSON.stringify({ "Connect": {addr} }));
                });
            }
        }
        console.log("Received:", event.data);
    };

    socket.onclose = function() {
        console.log("WebSocket disconnected, trying to reconnect...");
        setTimeout(connect, reconnectInterval);
    };

    socket.onerror = function(error) {
        console.error("WebSocket error:", error);
        // Optionally close on error to trigger reconnect
        socket.close();
    };
}

connect();

const ws_send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(message);
    } else {
        console.error("WebSocket is not open. Cannot send message:", message);
    }
}

el("request-samples").addEventListener("click", function() {
    ws_send(JSON.stringify({ "RequestNewRange": {
            "start": 0,
            "end": 99999999
        }
    }));
});