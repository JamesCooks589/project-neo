import type { JsonValue } from './schema';
import { sensitiveName } from './prepare';

const marker = '[REDACTED]';

/** Diagnostic copies only: the interpreter always retains the original values. */
export class Redactor {
  private readonly secrets = new Set<string>();

  remember = (value: string) => {
    if (value !== '') {
      this.secrets.add(value);
      this.secrets.add(encodeURIComponent(value));
    }
  };

  discover(value: JsonValue) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child) => this.discover(child));
      return;
    }
    if (
      typeof value.name === 'string' &&
      sensitiveName.test(value.name) &&
      typeof value.value === 'string'
    ) {
      this.remember(value.value);
    }
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveName.test(key) && typeof child === 'string')
        this.remember(child);
      else this.discover(child);
    }
  }

  private text(value: string) {
    let result = value;
    for (const secret of [...this.secrets].sort(
      (a, b) => b.length - a.length,
    )) {
      result = result.replaceAll(secret, marker);
    }
    return result;
  }

  copy(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((child) => this.copy(child));
    if (value.encoding === 'base64' && typeof value.data === 'string') {
      const text = Buffer.from(value.data, 'base64').toString('utf8');
      const sensitive =
        this.secrets.size > 0 ||
        /(?:password|token|secret|authorization|cookie|api[-_]?key)["']?\s*[:=]/i.test(
          text,
        );
      if (sensitive) {
        return { ...value, data: marker, preview: marker, redacted: true };
      }
    }
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    const sensitiveEntry =
      typeof value.name === 'string' && sensitiveName.test(value.name);
    for (const [key, child] of Object.entries(value)) {
      // Secret references describe a name, not a resolved credential.
      if (
        (sensitiveName.test(key) || (sensitiveEntry && key === 'value')) &&
        !(
          child !== null &&
          typeof child === 'object' &&
          !Array.isArray(child) &&
          child.kind === 'secret'
        )
      ) {
        result[key] = marker;
      } else result[key] = this.copy(child);
    }
    return result;
  }
}
