import type { AuthConfig } from '@benhouse/config';
import { readAppConfig } from '@benhouse/config';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export const authConfigProvider = {
  provide: AUTH_CONFIG,
  useFactory: (): AuthConfig => readAppConfig().auth,
};
