// src/lib/utils/error.ts
//
// Reading a thrown value of unknown type. A catch variable is `unknown` (it can be anything that was
// thrown), so these read what a catch block needs from it without `any`.

/**
 * Safely extracts a string error message from an unknown thrown object.
 * This completely eliminates the need for `catch (error: unknown)`.
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        return String((error as Record<string, unknown>).message);
    }
    return 'An unknown error occurred';
}

/**
 * The thrown value's own non-empty `message`, else `fallback` - exactly what `e?.message || fallback`
 * answered, so a catch's own wording ("Scan failed.") still shows when there's no message to show.
 */
export function errorMessageOr(error: unknown, fallback: string): string {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message !== '' ? message : fallback;
}

/** An HTTP error's response status - where axios puts it (`error.response.status`) - or undefined. */
export function errorResponseStatus(error: unknown): number | undefined {
    const status = (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

/** A Node (ENOENT, EXDEV, …) or Prisma (P2002, …) error's `code`, or undefined. */
export function errorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}
