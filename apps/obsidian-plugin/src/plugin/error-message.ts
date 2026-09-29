/** What a caught value says, for a Notice or an inline report. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
