const NodeHelper = require("node_helper");
const { UptimeKumaApi } = require("./uptime-kuma-api");

// Uptime Kuma recalculates /metrics on every scrape, so don't hammer it.
const MIN_UPDATE_INTERVAL = 10000;
const DEFAULT_UPDATE_INTERVAL = 60000;

module.exports = NodeHelper.create({
    start: function () {
        console.log("Starting MMM-AuthenticatedUptimeKuma node_helper");
        this.instances = new Map();
    },

    stop: function () {
        for (const identifier of [ ...this.instances.keys() ]) {
            this.teardown(identifier);
        }
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.configure(payload.identifier, payload.config);
        }
    },

    // Stop polling for a module instance, e.g. before reconfiguring it after a
    // browser reload.
    teardown: function (identifier) {
        const instance = this.instances.get(identifier);
        if (!instance) {
            return;
        }

        clearInterval(instance.timer);
        this.instances.delete(identifier);
    },

    configure: function (identifier, config) {
        this.teardown(identifier);

        let api;
        try {
            api = new UptimeKumaApi(config);
        } catch (error) {
            this.reportError(identifier, error);
            return;
        }

        const interval = Math.max(Number(config.updateInterval) || DEFAULT_UPDATE_INTERVAL, MIN_UPDATE_INTERVAL);
        const instance = { api, fetching: false, timer: null };

        instance.timer = setInterval(() => {
            this.poll(identifier);
        }, interval);

        this.instances.set(identifier, instance);
        this.poll(identifier);
    },

    poll: async function (identifier) {
        const instance = this.instances.get(identifier);

        // Skip if the previous scrape is still running, e.g. on a slow instance.
        if (!instance || instance.fetching) {
            return;
        }

        instance.fetching = true;

        try {
            const result = await instance.api.fetchMonitors();

            // The instance may have been torn down while the request was open.
            if (this.instances.get(identifier) !== instance) {
                return;
            }

            this.sendSocketNotification("MONITOR_DATA", {
                identifier,
                monitors: result.monitors,
                hasMonitorIds: result.hasMonitorIds,
                hasUptime: result.hasUptime,
            });
        } catch (error) {
            if (this.instances.get(identifier) === instance) {
                this.reportError(identifier, error);
            }
        } finally {
            instance.fetching = false;
        }
    },

    reportError: function (identifier, error) {
        const message = error.message || String(error);

        console.error(`MMM-AuthenticatedUptimeKuma: ${message}`);
        this.sendSocketNotification("FETCH_ERROR", { identifier, message });
    },
});
