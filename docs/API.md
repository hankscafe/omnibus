# Omnibus API Reference

[← Back to Main README](../README.md)

## Overview
Omnibus provides a high-performance, authenticated API endpoint for system monitoring and dashboard integration (like [Homepage](https://gethomepage.dev)).

### Authentication
All API requests require an API Key. This can be found or generated in your Omnibus **System Settings**.

Authentication can be handled in three ways:
1. **Header:** `x-api-key: YOUR_API_KEY`
2. **Bearer Token:** `Authorization: Bearer YOUR_API_KEY`
3. **Query Parameter:** `?apiKey=YOUR_API_KEY`

---

## Homepage Integration

To display Omnibus stats on your Homepage dashboard, use the following configuration in your `services.yaml`.

> **Note:** Due to Homepage's YAML parsing logic, use the **nested field mapping** syntax `field: { data: key }` as shown below.

```yaml
- Media:
    - Omnibus:
        icon: omnibus.png
        href: http://your-ip:3000
        description: Comic Book Manager
        widget:
            type: customapi
            url: http://your-ip:3000/api/v1/stats
            method: GET
            headers:
                x-api-key: "your_api_key_here"
            mappings:
              - field: { data: systemHealth }
                label: Status
                format: text
              - field: { data: totalSeries }
                label: Series
                format: number
              - field: { data: totalIssues }
                label: Issues
                format: number
              - field: { data: activeDownloads }
                label: Downloads
                format: number

```

---

## Endpoint: `GET /api/v1/stats`

| Field | Type | Description |
| --- | --- | --- |
| `systemHealth` | `string` | Status: `Healthy`, `Update Available`, or `Degraded`. |
| `currentVersion` | `string` | The version of Omnibus currently running. |
| `latestVersion` | `string` | The most recent version available on GitHub. |
| `totalSeries` | `number` | Total number of series in the library. |
| `totalIssues` | `number` | Total count of comic/manga files indexed. |
| `totalRequests` | `number` | Lifetime count of user requests. |
| `totalUsers` | `number` | Number of registered users. |
| `activeDownloads` | `number` | Count of active tasks in the download client. |
| `completed30d` | `number` | Successful imports in the last 30 days. |
| `failed30d` | `number` | Total failed/error tasks in the last 30 days. |

---