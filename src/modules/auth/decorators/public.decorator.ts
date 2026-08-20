import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como accesible sin token.
 *
 * Existe porque el guard de JWT es global: lo normal es exigir autenticacion y
 * lo excepcional es no exigirla, asi que la excepcion se escribe a mano y se ve
 * en el diff.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
