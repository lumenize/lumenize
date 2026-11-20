import { getCurrentScope, getCurrentInstance } from 'vue';
import { probes } from './holder';

export function probe(where: string): string {
  probes.push({ where, scope: !!getCurrentScope(), instance: !!getCurrentInstance() });
  return '';
}
