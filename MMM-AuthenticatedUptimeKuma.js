/* global Module, Log */

// Values of the monitor_status metric.
const STATUS_DOWN = 0;
const STATUS_UP = 1;
const STATUS_PENDING = 2;
const STATUS_MAINTENANCE = 3;

// Widget settings, and the CSS custom property each one sets.
const WIDGET_STYLE_PROPERTIES = {
    minWidth: "--uptimekuma-tile-min-width",
    width: "--uptimekuma-tile-width",
    height: "--uptimekuma-tile-height",
};

// Colors used to be configured here, they are styled in CSS now.
const OBSOLETE_WIDGET_SETTINGS = ["titleColor", "backgroundColor", "descriptionColor"];

Module.register("MMM-AuthenticatedUptimeKuma", {
    defaults: {
        url: "",
        apiKey: "",
        username: "",
        password: "",
        updateInterval: 60 * 1000,
        ignoreCertErrors: false,
        displayType: "list",
        // Widget dimensions. Everything left at null keeps the value from
        // MMM-AuthenticatedUptimeKumaWidget.css. Colors, transparency and the
        // rest of the appearance are styled in css/custom.css.
        widgetSettings: {
            minWidth: null,
            width: null,
            height: null,
        },
        monitors: []
    },

    start: function () {
        this.monitorsById = {};
        this.monitorsByName = {};
        this.hasUptime = true;
        this.loaded = false;
        this.error = null;

        if (this.config.token) {
            Log.warn(`${this.name}: the token option is obsolete, this module now uses the Uptime Kuma API. Configure apiKey instead.`);
        }

        const obsoleteSettings = OBSOLETE_WIDGET_SETTINGS.filter((setting) => this.config.widgetSettings?.[setting] !== undefined);

        if (obsoleteSettings.length > 0) {
            Log.warn(`${this.name}: the widgetSettings ${obsoleteSettings.join(", ")} are obsolete, style the module in css/custom.css instead.`);
        }

        this.sendSocketNotification("CONFIG", {
            identifier: this.identifier,
            config: {
                url: this.config.url,
                apiKey: this.config.apiKey,
                username: this.config.username,
                password: this.config.password,
                updateInterval: this.config.updateInterval,
                ignoreCertErrors: this.config.ignoreCertErrors,
            },
        });
    },

    // Handle incoming data from node_helper.js
    socketNotificationReceived: function (notification, payload) {
        // The helper broadcasts to every instance of this module, so ignore
        // data meant for a differently configured one.
        if (payload.identifier !== this.identifier) {
            return;
        }

        switch (notification) {
            case "MONITOR_DATA":
                this.updateMonitors(payload);
                break;
            case "FETCH_ERROR":
                this.error = payload.message;
                break;
            default:
                return;
        }

        this.updateDom();
    },

    // Index the monitors reported by the API by both id and name. Uptime Kuma
    // 2.x labels its metrics with monitor_id, 1.23.x only with monitor_name.
    updateMonitors: function (payload) {
        this.monitorsById = {};
        this.monitorsByName = {};

        for (const monitor of Object.values(payload.monitors)) {
            if (monitor.id !== null) {
                this.monitorsById[monitor.id] = monitor;
            }
            if (monitor.name) {
                this.monitorsByName[monitor.name] = monitor;
            }
        }

        if (!payload.hasMonitorIds && this.config.monitors.some((monitor) => monitor.id !== undefined)) {
            Log.warn(`${this.name}: this Uptime Kuma version does not expose monitor ids in /metrics. Match monitors by monitorName instead.`);
        }

        this.hasUptime = payload.hasUptime;
        this.loaded = true;
        this.error = null;
    },

    // Find the API monitor a configured entry refers to, by id where available
    // and by name otherwise.
    resolveMonitor: function (monitorConfig) {
        if (monitorConfig.id !== undefined && this.monitorsById[monitorConfig.id]) {
            return this.monitorsById[monitorConfig.id];
        }

        const name = monitorConfig.monitorName ?? monitorConfig.name;

        return name ? this.monitorsByName[name] ?? null : null;
    },

    // Generate the DOM for display
    getDom: function () {
        var wrapper = document.createElement("div");

        if (this.error) {
            wrapper.innerHTML = `Error: ${this.error}`;
            return wrapper;
        }

        if (!this.loaded) {
            wrapper.innerHTML = "Loading monitor data...";
            return wrapper;
        }

        switch (this.config.displayType) {
            case "list":
                return this.renderList(wrapper);
            case "widget":
                return this.renderWidget(wrapper);
            default:
                wrapper.innerHTML = "Invalid display type";
        }

        return wrapper;
    },

    renderList: function (wrapper) {
        var table = document.createElement("table");
        table.classList.add("small");

        // Iterate through the configured monitors
        this.config.monitors.forEach((monitorConfig) => {
            const monitor = this.resolveMonitor(monitorConfig);

            // Create a table row for each monitor
            var row = document.createElement("tr");

            // Current state indicator (circle)
            var stateCell = document.createElement("td");
            stateCell.classList.add("state-indicator");
            stateCell.appendChild(this.getStateIndicator(monitor));
            row.appendChild(stateCell);

            // Monitor name
            var nameCell = document.createElement("td");
            nameCell.innerHTML = monitorConfig.name ?? monitor?.name ?? "";
            nameCell.classList.add("title");
            row.appendChild(nameCell);

            // Monitor data (ping, uptime, etc.)
            var dataCell = document.createElement("td");
            dataCell.style.paddingLeft = "20px"; // Add padding for better alignment
            dataCell.innerHTML = this.getMonitorData(monitorConfig, monitor);
            row.appendChild(dataCell);

            table.appendChild(row);
        });

        wrapper.appendChild(table);

        return wrapper;
    },

    renderWidget: function (wrapper) {
        // Create a container for the list of widgets
        var listContainer = document.createElement("div");
        listContainer.classList.add("widget-list-container");
        this.applyWidgetSettings(listContainer);

        // Iterate through the configured monitors and create a widget for each
        this.config.monitors.forEach((monitorConfig) => {
            const monitor = this.resolveMonitor(monitorConfig);

            // Create a widget container for each monitor
            var widgetContainer = document.createElement("div");
            widgetContainer.classList.add("monitor-widget");

            // Monitor name
            var nameDisplay = document.createElement("div");
            nameDisplay.classList.add("monitor-name");
            nameDisplay.innerHTML = monitorConfig.name ?? monitor?.name ?? "";

            // Monitor data
            var dataDisplay = document.createElement("div");
            dataDisplay.classList.add("monitor-data", this.getStatusClass(monitor));
            dataDisplay.innerHTML = this.getMonitorData(monitorConfig, monitor);

            // Data display name
            var dataDisplayName = document.createElement("div");
            dataDisplayName.classList.add("monitor-data-name");
            dataDisplayName.innerHTML = this.getDataDisplayName(monitorConfig.display);

            // Append elements to the widget container
            widgetContainer.appendChild(dataDisplayName);
            widgetContainer.appendChild(nameDisplay);
            widgetContainer.appendChild(dataDisplay);

            // Append the widget to the list container
            listContainer.appendChild(widgetContainer);
        });

        // Append the list container to the wrapper
        wrapper.appendChild(listContainer);

        return wrapper;
    },

    // Turn the configured widget dimensions into CSS custom properties.
    // Settings left unset are not written at all, so the stylesheet default
    // applies and css/custom.css stays free to override it.
    applyWidgetSettings: function (element) {
        // MagicMirror replaces the whole widgetSettings object when only part
        // of it is configured, so fill the missing entries back in.
        const settings = Object.assign({}, this.defaults.widgetSettings, this.config.widgetSettings);

        for (const [setting, property] of Object.entries(WIDGET_STYLE_PROPERTIES)) {
            const value = settings[setting];

            if (value !== null && value !== undefined && value !== "") {
                element.style.setProperty(property, String(value));
            }
        }
    },

    // Map a monitor status onto its display class, which carries the color.
    // Paused monitors drop out of /metrics entirely, so an unknown monitor is
    // shown as gray.
    getStatusClass: function (monitor) {
        switch (monitor?.status) {
            case STATUS_UP:
                return "status-up";
            case STATUS_DOWN:
                return "status-down";
            case STATUS_PENDING:
                return "status-pending";
            case STATUS_MAINTENANCE:
                return "status-maintenance";
            default:
                return "status-unknown";
        }
    },

    // Get the color-coded circle based on the status
    getStateIndicator: function (monitor) {
        var indicator = document.createElement("div");
        indicator.classList.add("circle-indicator", this.getStatusClass(monitor));

        return indicator;
    },

    // Get the monitor data based on the configuration
    getMonitorData: function (monitorConfig, monitor) {
        if (!monitor) {
            return "N/A";
        }

        switch (monitorConfig.display) {
            case "ping":
                return `${this.formatPing(monitor.ping)} ms`;
            case "avgPing":
                return `${this.formatPing(monitor.avgPing["1d"])} ms (⌀24h)`;
            case "uptime24":
                return `${this.formatUptime(monitor.uptime["1d"])}% (24h)`;
            case "uptime30":
                return `${this.formatUptime(monitor.uptime["30d"])}% (30 days)`;
            default:
                return "N/A";
        }
    },

    formatPing: function (ping) {
        return typeof ping === "number" ? Math.round(ping) : "N/A";
    },

    formatUptime: function (uptime) {
        return typeof uptime === "number" ? uptime.toFixed(2) : "N/A";
    },

    getDataDisplayName: function (dataName) {
        switch (dataName) {
            case "ping":
                return "Ping";
            case "avgPing":
                return "Average Ping";
            case "uptime24":
                return "Uptime (24h)";
            case "uptime30":
                return "Uptime (30 days)";
            default:
                return "";
        }
    },

    getStyles: function () {
        const styles = ["MMM-AuthenticatedUptimeKuma.css"];

        if (this.config.displayType === "widget") {
            styles.push("MMM-AuthenticatedUptimeKumaWidget.css");
        }

        return styles;
    },
});
