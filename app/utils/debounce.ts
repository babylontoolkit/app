export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;

  /**
   * Drop any pending trailing call. For when the value the pending call would write has just been
   * deliberately cleared — e.g. the draft-prompt cookie after `/clear`: the debounced cache write
   * fires up to `wait` ms AFTER the command ran, resurrecting the exact text the user cleared.
   */
  cancel(): void;
}

export function debounce<T extends (...args: any[]) => any>(func: T, wait: number): DebouncedFunction<T> {
  let timeout: NodeJS.Timeout;

  const executedFunction = function (...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  } as DebouncedFunction<T>;

  executedFunction.cancel = () => clearTimeout(timeout);

  return executedFunction;
}
