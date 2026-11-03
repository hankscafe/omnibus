import axios from 'axios';

type TransmissionClient = {
    url: string;
    user?: string | null;
    pass?: string | null;
};

type RpcParams = Record<string, unknown>;
type RpcDialect = 'legacy' | 'json-rpc-2.0';
type TransmissionTorrent = {
    id?: number;
    name?: string;
    hash_string?: string;
    percent_done?: number;
    total_size?: number;
    status?: number;
    labels?: string[];
    seed_ratio_limit?: number;
    seed_ratio_mode?: number;
};
type TransmissionRpcResult = {
    rpc_version?: number;
    version?: string;
    torrents?: TransmissionTorrent[];
    torrent_added?: TransmissionTorrent;
    torrent_duplicate?: TransmissionTorrent;
};

const legacyArgumentNames: Record<string, string> = {
    delete_local_data: 'delete-local-data',
    download_dir: 'download-dir',
    rpc_version: 'rpc-version',
};

function toCamelCase(value: string) {
    return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function toLegacyKey(key: string) {
    return legacyArgumentNames[key] || toCamelCase(key);
}

function toLegacyParams(params: RpcParams): RpcParams {
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [
        toLegacyKey(key),
        key === 'fields' && Array.isArray(value) ? value.map(field => toLegacyKey(String(field))) : value,
    ]));
}

function normalizeLegacyKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeLegacyKeys);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/-/g, '_'),
        normalizeLegacyKeys(nestedValue),
    ]));
}

function rpcDialectFromVersion(version: unknown): RpcDialect {
    const majorVersion = Number.parseInt(String(version || '').split('.')[0], 10);
    return majorVersion >= 6 ? 'json-rpc-2.0' : 'legacy';
}

function buildPayload(dialect: RpcDialect, method: string, params: RpcParams, id: number) {
    if (dialect === 'json-rpc-2.0') {
        return { jsonrpc: '2.0', method, params, id };
    }
    return { method: method.replace(/_/g, '-'), arguments: toLegacyParams(params), tag: id };
}

function getHeader(headers: Record<string, unknown> | undefined, name: string) {
    if (!headers) return undefined;
    return headers[name.toLowerCase()] ?? headers[name];
}

export function transmissionRpcUrl(url: string) {
    const cleanUrl = url.replace(/\/+$/, '');
    return cleanUrl.endsWith('/transmission/rpc') ? cleanUrl : `${cleanUrl}/transmission/rpc`;
}

export function createTransmissionRpc(
    client: TransmissionClient,
    headers: Record<string, string>,
    timeoutMs: number,
) {
    const endpoint = transmissionRpcUrl(client.url);
    const auth = client.user || client.pass
        ? { username: client.user || '', password: client.pass || '' }
        : undefined;
    let sessionId: string | undefined;
    let dialect: RpcDialect | undefined;
    let requestId = 0;

    return async (method: string, params: RpcParams = {}): Promise<TransmissionRpcResult> => {
        requestId += 1;
        const requestDialect = dialect || 'legacy';
        const requestHeaders = {
            ...headers,
            ...(sessionId ? { 'X-Transmission-Session-Id': sessionId } : {}),
        };
        const config = { headers: requestHeaders, timeout: timeoutMs, ...(auth ? { auth } : {}) };

        let response;
        try {
            response = await axios.post(endpoint, buildPayload(requestDialect, method, params, requestId), config);
        } catch (error: unknown) {
            const errorResponse = (error as { response?: { status?: number; headers?: Record<string, unknown> } } | null)?.response;
            if (errorResponse?.status !== 409) throw error;

            const newSessionId = getHeader(errorResponse.headers, 'x-transmission-session-id');
            if (typeof newSessionId !== 'string' || !newSessionId) {
                throw new Error('Transmission returned HTTP 409 without an X-Transmission-Session-Id header.');
            }

            sessionId = newSessionId;
            dialect = rpcDialectFromVersion(getHeader(errorResponse.headers, 'x-transmission-rpc-version'));
            response = await axios.post(
                endpoint,
                buildPayload(dialect, method, params, requestId),
                {
                    ...config,
                    headers: { ...headers, 'X-Transmission-Session-Id': sessionId },
                },
            );
        }

        if (dialect === 'json-rpc-2.0' || response.data?.jsonrpc === '2.0') {
            dialect = 'json-rpc-2.0';
            if (response.data?.error) {
                const detail = response.data.error.message || JSON.stringify(response.data.error);
                throw new Error(`Transmission RPC ${method} failed: ${detail}`);
            }
            return (response.data?.result || {}) as TransmissionRpcResult;
        }

        dialect = 'legacy';
        if (response.data?.result !== 'success') {
            const detail = response.data?.['result-text'] || response.data?.result_text || response.data?.result || 'Unknown RPC error';
            throw new Error(`Transmission RPC ${method} failed: ${detail}`);
        }
        return normalizeLegacyKeys(response.data.arguments || {}) as TransmissionRpcResult;
    };
}

export async function getTransmissionTorrents(
    rpc: ReturnType<typeof createTransmissionRpc>,
) {
    const session = await rpc('session_get');
    const fields = ['id', 'name', 'hash_string', 'percent_done', 'total_size', 'status'];
    if (Number(session.rpc_version) >= 16) fields.push('labels');

    const result = await rpc('torrent_get', { fields });
    return Array.isArray(result.torrents) ? result.torrents : [];
}

export function mapTransmissionDownloads(torrents: TransmissionTorrent[], categoryString: string, clientName: string) {
    const allowedCategories = categoryString.toLowerCase().split(',').map(category => category.trim()).filter(Boolean);
    const labelsInUse = torrents.some(torrent => Array.isArray(torrent.labels) && torrent.labels.length > 0);
    const visibleTorrents = labelsInUse
        ? torrents.filter(torrent => Array.isArray(torrent.labels) && torrent.labels.some((label: string) => allowedCategories.includes(label.toLowerCase())))
        : torrents;
    const statuses = ['Stopped', 'Queued to verify', 'Verifying', 'Queued to download', 'Downloading', 'Queued to seed', 'Seeding'];

    return visibleTorrents.map(torrent => ({
        id: torrent.hash_string || String(torrent.id),
        name: torrent.name,
        progress: (Number(torrent.percent_done || 0) * 100).toFixed(1),
        status: statuses[torrent.status ?? -1] || String(torrent.status),
        clientName,
        size: (Number(torrent.total_size || 0) / 1024 / 1024).toFixed(2) + ' MB',
    }));
}