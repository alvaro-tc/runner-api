import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { permisosEfectivos } from './permisos';

/**
 * Permisos de cada rol, en memoria.
 *
 * El guard corre en cada peticion del panel: ir a la base cada vez seria una
 * consulta por request para un dato que cambia una vez al mes.
 * ponytail: cache de un solo proceso; con varias instancias de la API, invalidar via Redis pub/sub.
 */
@Injectable()
export class PermisosService implements OnModuleInit {
  private porRol = new Map<string, string[]>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.recargar();
  }

  /** Llamar despues de crear, editar o borrar un rol. */
  async recargar() {
    const roles = await this.prisma.role.findMany({ select: { key: true, permissions: true } });
    this.porRol = new Map(roles.map((r) => [r.key, permisosEfectivos(r.permissions)]));
  }

  de(roleKey: string | undefined): string[] {
    if (!roleKey) return [];
    return this.porRol.get(roleKey) ?? [];
  }

  tiene(roleKey: string | undefined, permiso: string): boolean {
    return this.de(roleKey).includes(permiso);
  }
}
