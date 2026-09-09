const http = require("node:http");
const https = require("node:https");

const MAX_REDIRECTS = 3;

// Labels that identify the monitor a sample belongs to. Everything else on a
// sample line is either a user tag or the "window" dimension.
const MONITOR_LABELS = {
    monitor_id: "id",
    monitor_name: "name",
    monitor_type: "type",
    monitor_url: "url",
    monitor_hostname: "hostname",
    monitor_port: "port",
};

/**
 * Turn a Prometheus escaped label value back into its raw form.
 * @param {string} value Escaped label value without the surrounding quotes
 * @returns {string} The unescaped value
 */
function unescapeLabelValue(value) {
    return value.replace(/\\(["\\n])/g, (_match, char) => {
        return char === "n" ? "\n" : char;
    });
}

/**
 * Parse the label block of a sample line into a plain object.
 * @param {string} text Contents between the curly braces
 * @returns {object} Label name to unescaped value
 */
function parseLabels(text) {
    const labels = {};
    const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

    let match;
    while ((match = pattern.exec(text)) !== null) {
        labels[match[1]] = unescapeLabelValue(match[2]);
    }

    return labels;
}

/**
 * Convert a Prometheus sample value into a number.
 * @param {string} token The raw value token
 * @returns {?number} The value, or null when it carries no usable number
 */
function parseSampleValue(token) {
    if (token === "NaN") {
        return null;
    }
    if (token === "+Inf" || token === "Inf") {
        return Number.POSITIVE_INFINITY;
    }
    if (token === "-Inf") {
        return Number.NEGATIVE_INFINITY;
    }

    const value = Number.parseFloat(token);

    return Number.isNaN(value) ? null : value;
}

/**
 * Split a single sample line into metric name, labels and value.
 * Label values may legally contain braces and spaces, so the label block is
 * scanned with quote awareness instead of matched with a regex.
 * @param {string} line One line of the exposition format
 * @returns {?{name: string, labels: object, value: ?number}} The parsed sample, or null if the line is not one
 */
function parseSampleLine(line) {
    const braceStart = line.indexOf("{");

    if (braceStart === -1) {
        const parts = line.split(/[ \t]+/);
        if (parts.length < 2) {
            return null;
        }
        return {
            name: parts[0],
            labels: {},
            value: parseSampleValue(parts[1]),
        };
    }

    let cursor = braceStart + 1;
    let inQuotes = false;
    let escaped = false;

    for (; cursor < line.length; cursor++) {
        const char = line[cursor];

        if (escaped) {
            escaped = false;
        } else if (inQuotes && char === "\\") {
            escaped = true;
        } else if (char === "\"") {
            inQuotes = !inQuotes;
        } else if (char === "}" && !inQuotes) {
            break;
        }
    }

    if (cursor >= line.length) {
        return null; // Unterminated label block
    }

    const remainder = line.slice(cursor + 1).trim();
    if (!remainder) {
        return null;
    }

    return {
        name: line.slice(0, braceStart),
        labels: parseLabels(line.slice(braceStart + 1, cursor)),
        value: parseSampleValue(remainder.split(/[ \t]+/)[0]),
    };
}

/**
 * Key a sample to a monitor. Uptime Kuma 2.x exposes monitor_id, 1.23.x only
 * exposes monitor_name, so the name is used as fallback identity.
 * @param {object} labels Labels of the sample
 * @returns {?string} The monitor key, or null when the sample is not monitor scoped
 */
function monitorKey(labels) {
    if (labels.monitor_id) {
        return labels.monitor_id;
    }
    if (labels.monitor_name) {
        return `name:${labels.monitor_name}`;
    }
    return null;
}

/**
 * Parse a Prometheus exposition payload into per-monitor data.
 * @param {string} body The raw response body of /metrics
 * @returns {{monitors: object, hasMonitorIds: boolean, hasUptime: boolean}} Monitors keyed by monitor key, plus which optional data the instance exposes
 */
function parseMetrics(body) {
    const monitors = {};
    let hasMonitorIds = false;
    let hasUptime = false;

    for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const sample = parseSampleLine(line);
        if (!sample || !sample.name.startsWith("monitor_")) {
            continue;
        }

        const key = monitorKey(sample.labels);
        if (key === null) {
            continue;
        }

        if (!monitors[key]) {
            monitors[key] = {
                id: null,
                name: null,
                type: null,
                url: null,
                hostname: null,
                port: null,
                status: null,
                ping: null,
                avgPing: {},
                uptime: {},
                certDaysRemaining: null,
                certIsValid: null,
            };
        }

        const monitor = monitors[key];

        for (const [ label, field ] of Object.entries(MONITOR_LABELS)) {
            const value = sample.labels[label];
            if (value === undefined || value === "") {
                continue;
            }
            monitor[field] = field === "id" ? Number.parseInt(value, 10) : value;
        }

        if (monitor.id !== null) {
            hasMonitorIds = true;
        }

        const window = sample.labels.window;

        switch (sample.name) {
            case "monitor_status":
                monitor.status = sample.value;
                break;

            case "monitor_response_time":
                // Uptime Kuma reports -1 when the heartbeat carried no ping.
                monitor.ping = sample.value !== null && sample.value >= 0 ? sample.value : null;
                break;

            case "monitor_response_time_seconds":
                if (window && sample.value !== null) {
                    monitor.avgPing[window] = sample.value * 1000;
                }
                break;

            case "monitor_uptime_ratio":
                if (window && sample.value !== null) {
                    monitor.uptime[window] = sample.value * 100;
                    hasUptime = true;
                }
                break;

            case "monitor_cert_days_remaining":
                monitor.certDaysRemaining = sample.value;
                break;

            case "monitor_cert_is_valid":
                monitor.certIsValid = sample.value === 1;
                break;

            default:
                break;
        }
    }

    return { monitors, hasMonitorIds, hasUptime };
}

/**
 * Build the /metrics URL for a configured Uptime Kuma base URL, preserving any
 * sub-path the instance is served under.
 * @param {string} baseUrl The configured instance URL
 * @returns {URL} The absolute metrics URL
 */
function metricsUrl(baseUrl) {
    const trimmed = String(baseUrl ?? "").trim();
    if (!trimmed) {
        throw new Error("No url configured");
    }

    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const base = withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;

    return new URL("metrics", base);
}

/**
 * Build the Basic auth header. Uptime Kuma ignores the username when API keys
 * are enabled and expects the key as password; when API keys are disabled it
 * accepts the admin credentials instead.
 * @param {{apiKey?: string, username?: string, password?: string}} credentials The configured credentials
 * @returns {string} The Authorization header value
 */
function authorizationHeader({ apiKey, username, password }) {
    const user = username || "";
    const secret = apiKey || password || "";

    return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
}

/**
 * Perform a GET request, following a bounded number of redirects.
 * @param {URL} url The URL to request
 * @param {{headers: object, ignoreCertErrors: boolean, timeout: number}} options Request options
 * @param {number} redirectsLeft How many further redirects may be followed
 * @returns {Promise<string>} The response body
 */
function get(url, options, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === "https:" ? https : http;

        const request = transport.request(url, {
            method: "GET",
            headers: options.headers,
            rejectUnauthorized: !options.ignoreCertErrors,
            timeout: options.timeout,
        }, (response) => {
            const { statusCode, headers } = response;

            if ([ 301, 302, 303, 307, 308 ].includes(statusCode) && headers.location) {
                response.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error("Too many redirects"));
                    return;
                }
                get(new URL(headers.location, url), options, redirectsLeft - 1).then(resolve, reject);
                return;
            }

            if (statusCode === 401 || statusCode === 403) {
                response.resume();
                reject(new Error("Authentication failed - check your apiKey"));
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${statusCode} from ${url.pathname}`));
                return;
            }

            response.setEncoding("utf8");

            let body = "";
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                resolve(body);
            });
        });

        request.on("timeout", () => {
            request.destroy(new Error("Request timed out"));
        });

        request.on("error", reject);
        request.end();
    });
}

class UptimeKumaApi {
    /**
     * @param {object} config Connection settings
     * @param {string} config.url Base URL of the Uptime Kuma instance
     * @param {string} [config.apiKey] API key used as Basic auth password
     * @param {string} [config.username] Username, only needed when API keys are disabled
     * @param {string} [config.password] Password, only needed when API keys are disabled
     * @param {boolean} [config.ignoreCertErrors] Accept self-signed certificates
     * @param {number} [config.timeout] Request timeout in milliseconds
     */
    constructor(config) {
        this.url = metricsUrl(config.url);
        this.headers = {
            Authorization: authorizationHeader(config),
            Accept: "text/plain",
        };
        this.ignoreCertErrors = Boolean(config.ignoreCertErrors);
        this.timeout = config.timeout ?? 10000;
    }

    /**
     * Fetch and parse the current monitor state.
     * @returns {Promise<{monitors: object, hasMonitorIds: boolean, hasUptime: boolean}>} The parsed metrics
     */
    async fetchMonitors() {
        const body = await get(this.url, {
            headers: this.headers,
            ignoreCertErrors: this.ignoreCertErrors,
            timeout: this.timeout,
        });

        return parseMetrics(body);
    }
}

module.exports = { UptimeKumaApi, parseMetrics, metricsUrl };
