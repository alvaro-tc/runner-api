import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../../../generated/prisma/enums';

export const ROLES_KEY = 'roles';

/** Restringe un endpoint a ciertos roles. Ej.: `@Roles('admin')`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
