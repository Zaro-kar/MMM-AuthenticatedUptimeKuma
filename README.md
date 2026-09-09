# MMM-AuthenticatedUptimeKuma
A module for displaying uptime kuma status. This does not require a status page — it reads your monitors from the authenticated Uptime Kuma API using an API key. There are two display types:

### List
![image](./screenshots/simple.png)

### Widget

![image](./screenshots/widgets.png)

## Installation

Navigate to the MagicMirror's Module folder:

```bash
cd ~/MagicMirror/modules
```

Clone this repository:

```bash
git clone https://github.com/totoluto/MMM-AuthenticatedUptimeKuma.git
```

The module has no dependencies, so there is nothing to install. Just configure it in your `config.js` file.

## Creating an API key

The module authenticates against the `/metrics` endpoint of your Uptime Kuma instance with an API key:

1. Open your Uptime Kuma instance and go to **Profile → Settings → API Keys**.
2. Click **Add API Key**, give it a name and either set an expiry date or let it never expire.
3. Copy the generated key — Uptime Kuma will not show it again.
4. Put it into the `apiKey` option of the module config.

You can verify the key works before configuring the module:

```bash
curl -u ":YOUR_API_KEY" https://your-url.com/metrics
```

> **Note:** As soon as you create your first API key, Uptime Kuma permanently disables username/password authentication for the metrics endpoint. If you have not created any API key yet, you can use the `username` and `password` options with your Uptime Kuma login instead.

## Using the module
To use this module, add the configuration to the modules array in `config/config.js` file:

```js
{
	module: "MMM-AuthenticatedUptimeKuma",
	position: "bottom_right",
	config: {
		url: "https://your-url.com",
		apiKey: "uk1_xxxxxxxxxxxxxxxxxxxx",
		updateInterval: 60 * 1000,
		displayType: "widget",
        widgetSettings: {
			titleColor: "black",
			backgroundColor: "#FFFFFF",
			descriptionColor: "#666",
			minWidth: "200px"
		},
		monitors: [
    		{
        		id: 3,
        		name: "Docker Containers",
        		display: "uptime24",       
 			},
			{
        		id: 1,
        		name: "System",
        		display: "uptime24",
    		},
        ]
	}
		
}
```

## Configuration Options


| Option | Default | Description |
|-----|-----|-----|
| `url` | `""` | URL/IP of your Uptime-Kuma instance. A sub-path is supported, e.g. `https://your-url.com/kuma`. |
| `apiKey` | `""` | API key of your Uptime-Kuma instance, see [Creating an API key](#creating-an-api-key). |
| `username` | `""` | Only needed if you have **not** created any API key. Your Uptime-Kuma login name. |
| `password` | `""` | Only needed if you have **not** created any API key. Your Uptime-Kuma password. |
| `updateInterval` | `60000` | How often the monitor data is fetched, in milliseconds. Values below `10000` are raised to `10000` to avoid hammering your instance. |
| `ignoreCertErrors` | `false` | Set to `true` if your instance uses a self-signed certificate. |
| `displayType` | `"list"` | This specifies how the module is shown. There are two valid options: `list`, `widget` |
| `widgetSettings` | | In here there are all the settings which will be applied to the widget. If you only want to use the list, then you don't need to specify this option. |
| `widgetSettings.titleColor` | `"black"` | The color of the Widget Titel. Any HTML color is allowed or an hex value. |
| `widgetSettings.backgroundColor` | `"#FFFFFF"` | The background color of the widget. Any HTML color is allowed or an hex value. |
| `widgetSettings.descriptionColor` | `"#666"` | This is the desciption color which let's you know what you are displaying. Any HTML color is allowed or an hex value. |
| `widgetSettings.minWidth` | `200px` | The min with of the widget itself. Can be any CSS option for dimensions. |
| `monitors` | `[]` | In here all the monitors which you want to display are listed and configured. By default the array is empty and you need to add your monitors.
| `monitors[XY].id` | | Enter the ID of your monitor which should be displayed.
| `monitors[XY].name` | | A Descriptive Name for your monitor.
| `monitors[XY].monitorName` | | Optional. The monitor name as it is in Uptime Kuma, used to match the monitor when your instance does not report monitor IDs (see [Uptime Kuma versions](#uptime-kuma-versions)). Defaults to `name`.
| `monitors[XY].display` | | Specify what you want to show on your widget/list. There are several types: <ul><li>`ping` shows the current ping of your monitor.</li><li>`avgPing` shows the average ping (past 24 hours) of your monitor.</li>`uptime24` shows the uptime in the past 24 hours in %</li><li>`uptime30` shows the uptime in the past 30 days in %</li></ul>

## Status colors

| Color | Meaning |
|-----|-----|
| green | Monitor is up |
| red | Monitor is down |
| orange | Monitor is pending |
| blue | Monitor is under maintenance |
| gray | Monitor is unknown — it is paused, or no monitor matched your configured `id`/`monitorName` |

## Uptime Kuma versions

The metrics endpoint got extended in Uptime Kuma 2.x, which changes what this module can show:

| | Uptime Kuma 2.x | Uptime Kuma 1.23.x |
|-----|-----|-----|
| Status indicator | yes | yes |
| `ping` | yes | yes |
| `avgPing` | yes | no |
| `uptime24` / `uptime30` | yes | no |
| Monitor matching | by `id` | by `monitorName` |

On 1.23.x the endpoint exposes neither uptime percentages nor monitor IDs, so `avgPing`, `uptime24` and `uptime30` show `N/A` and monitors have to be matched by name:

```js
monitors: [
	{
		monitorName: "System",   // must match the monitor name in Uptime Kuma
		name: "System",
		display: "ping",
	},
]
```

## Find Monitor IDs

You can get your monitor ID by clicking on the Monitor on your Web-Instance and then you can check the ID in the URL.

```
https://your-url.com/dashboard/[ID]
```

## Migrating from the socket token

Earlier versions of this module logged into the Uptime Kuma socket with a generated socket token. That is no longer needed — replace the `token` option with `apiKey` and you are done. Everything else in your config stays the same. If `token` is still present, the module logs a warning and ignores it.
