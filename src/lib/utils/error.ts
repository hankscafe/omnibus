// src/lib/utils/error.ts

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