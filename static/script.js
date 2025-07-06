let socket;
let reconnectInterval = 1000; // 1 second

const el = (cls) => document.querySelector(`.${cls}`);
const q = (sel) => document.querySelectorAll(sel);

let request_start_tm = 0;
let request_end_tm = 100000;
function connect() {
    socket = new WebSocket(`ws://${window.location.host}/ws`);

    socket.onopen = function() {
        console.log("WebSocket connected");
    };

    socket.onmessage = async function(event) {
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
        if (msg["Stats"] !== undefined) {
            el("total-instant-events").innerHTML = msg["Stats"].instant_events;
            el("total-range-events").innerHTML = msg["Stats"].range_events;
        }
        if (msg["CurrentClientTimestamp"] !== undefined) {
            let tm = msg["CurrentClientTimestamp"][1];
            request_start_tm = tm - 10000000000; // last 10 seconds
            request_end_tm = tm;
        }
        if (msg["NewEvents"] !== undefined) {
            let data = msg["NewEvents"].data;
            let addr = msg["NewEvents"].addr;
            let thread_ord_id = msg["NewEvents"].thread_ord_id;

            const uint8Array = new Uint8Array(data);
            const view = new DataView(uint8Array.buffer);


            let offset = 0;

            // 1. Parse Instant Events
            const instantEventsLen = view.getUint32(offset, true);
            offset += 4;
            const instantEventsEnd = offset + instantEventsLen;

            let html = "";
            while (offset < instantEventsEnd) {
                const tm = Number(view.getBigUint64(offset, true)); // Convert to Number if timestamp fits
                offset += 8;
                const id = view.getUint8(offset);
                offset += 1;

                const str = `${addr}-${thread_ord_id}-${id}`;
                const color = await generateColorForThread(str);
                const pos = `${(tm - request_start_tm) / 1000000000 * 10}vw`;
                const vert_pos = `${thread_ord_id * 40}px`
                html += `<div class="event instant-event" style="background-color: ${color.hex}; left: ${pos}; top: ${vert_pos}"></div>`;
            }

            while (offset < data.byteLength) {
                const start = Number(view.getBigUint64(offset, true));
                offset += 8;
                const end = Number(view.getBigUint64(offset, true));
                offset += 8;
                const start_id = view.getUint8(offset);
                offset += 1;
                const end_id = view.getUint8(offset);
                offset += 1;

                const str = `${addr}-${thread_ord_id}-${start_id}`;
                const color = await generateColorForThread(str);
                const pos = `${(start - request_start_tm) / 1000000000 * 10}vw`;
                const vert_pos = `${thread_ord_id * 40}px`
                html += `<div class="event range-event" style="background-color: ${color.hex}; left: ${pos}; top: ${vert_pos}"></div>`;
            }

            el("events").innerHTML = html;
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
            "start": request_start_tm,
            "end": request_end_tm
        }
    }));
});

// Color generation function (from previous answer)
async function generateColorForThread(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const hue = parseInt(hashHex.substring(0, 4), 16) % 360;
    const saturation = 80 + (parseInt(hashHex.substring(4, 6), 16) % 20);
    const value = 30 + parseInt(hashHex.substring(6, 8), 16) % 20;

    const rgb = hsvToRgb(hue, saturation, value);
    const hex = `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

    return { hsv: [hue, saturation, value], rgb, hex };
}

// Helper: HSV to RGB conversion
function hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}