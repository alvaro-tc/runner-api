import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RegistrationStatus } from '../../../generated/prisma/enums';
import {
  CreateRouteDto,
  ListRoutesQueryDto,
  RouteDetailDto,
  RouteSummaryDto,
  UpdateRouteDto,
} from '../routes/dto/route.dto';
import { AdminService } from './admin.service';
import {
  ConfirmTransferDto,
  CreateCategoryDto,
  CreateExtraDto,
  CreateMarathonDto,
  CreateUserDto,
  FeePreviewDto,
  FeePreviewQueryDto,
  ImportResultsDto,
  ImportResultsResponseDto,
  ServiceFeeConfigDto,
  SetPasswordDto,
  UpdateCategoryDto,
  UpdateExtraDto,
  UpdateMarathonDto,
  UpdateUserDto,
} from './dto/admin.dto';

/**
 * Limite propio del panel.
 *
 * Mas apretado que el global: estos endpoints escriben configuracion de precios,
 * confirman cobros y exportan datos personales. Los usa una persona haciendo
 * clic, no una app, asi que 60 por minuto sobran — y si alguien roba un token de
 * admin, el techo acota lo que puede sacar antes de que se note.
 */
const LIMITE_ADMIN = { corto: { limit: 60, ttl: 60_000 } };

/**
 * API de administracion.
 *
 * **Aqui vive todo lo que hace el panel.** Es la regla del PROMT y es lo que
 * decide si el front-end web que venga despues se puede construir sin
 * reimplementar nada: la interfaz solo llama a estos endpoints.
 *
 * Todo exige rol `admin`. El guard de roles es global y se dispara con
 * `@Roles`, asi que un endpoint nuevo en esta clase que se olvide el decorador
 * queda abierto a cualquier usuario logueado: por eso el decorador va **en la
 * clase**, no en cada metodo.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles('admin')
@Throttle(LIMITE_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ─── Cargo por servicio ──────────────────────────────────────────────────

  @Get('service-fee')
  @ApiOperation({
    summary: 'Config global del cargo por servicio y las maratones que la sobrescriben',
  })
  verFees() {
    return this.admin.verFees();
  }

  @Put('service-fee')
  @ApiOperation({
    summary: 'Activar, desactivar o reconfigurar el cargo global',
    description:
      'Con `enabled: false` el total deja de llevar cargo **y la línea desaparece** de la ' +
      'respuesta de cotización: un "Bs 0,00" promete un cargo que hoy no se cobra.',
  })
  guardarFeeGlobal(@CurrentUser('sub') adminId: string, @Body() dto: ServiceFeeConfigDto) {
    return this.admin.guardarFeeGlobal(dto, adminId);
  }

  @Get('service-fee/preview')
  @ApiOperation({
    summary: 'Vista previa del efecto sobre un total de ejemplo',
    description:
      'Se calcula con la **misma** función que cobra de verdad, así que no puede desviarse. ' +
      'Sin `subtotalCents` usa Bs 200 de ejemplo.',
  })
  @ApiResponse({ status: 200, type: FeePreviewDto })
  previsualizar(@Query() query: FeePreviewQueryDto) {
    return this.admin.previsualizarFee(query.subtotalCents, query.marathonId);
  }

  @Put('marathons/:id/service-fee')
  @ApiOperation({
    summary: 'Override del cargo para una maratón',
    description:
      'El override manda **aunque venga apagado**: una maratón con una config `enabled: false` ' +
      'no cobra cargo, en vez de caer de vuelta a la global.',
  })
  guardarFeeDeMaraton(
    @CurrentUser('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: ServiceFeeConfigDto,
  ) {
    return this.admin.guardarFeeDeMaraton(id, dto, adminId);
  }

  @Delete('marathons/:id/service-fee')
  @ApiOperation({ summary: 'Quitar el override y volver a la config global' })
  quitarFeeDeMaraton(@Param('id') id: string) {
    return this.admin.quitarFeeDeMaraton(id);
  }

  // ─── Recorridos preestablecidos ──────────────────────────────────────────

  @Get('routes')
  @ApiOperation({
    summary: 'Recorridos cargados, archivados incluidos',
    description:
      'Es lo que llena el selector de recorrido del formulario de alta. Con ' +
      '`includeArchived=false` salen solo los que se pueden usar en una carrera nueva.',
  })
  @ApiResponse({ status: 200, type: [RouteSummaryDto] })
  listarRecorridos(@Query() query: ListRoutesQueryDto) {
    return this.admin.listarRecorridos({
      ...query,
      includeArchived: query.includeArchived ?? true,
    });
  }

  @Get('routes/:id')
  @ApiOperation({
    summary: 'Un recorrido con su trazado sin simplificar',
    description:
      'Sin simplificar porque desde aquí se edita: reguardar lo simplificado lo iría ' +
      'desgastando en cada pasada.',
  })
  @ApiResponse({ status: 200, type: RouteDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  verRecorrido(@Param('id') id: string) {
    return this.admin.verRecorrido(id);
  }

  @Post('routes')
  @ApiOperation({
    summary: 'Cargar un recorrido',
    description:
      'La distancia **no se manda**: se mide sobre la geometría. Es la que después hereda cada ' +
      'maratón que lo elija.',
  })
  @ApiResponse({ status: 201, type: RouteSummaryDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_ERROR: el GeoJSON no es un LineString utilizable',
  })
  crearRecorrido(@Body() dto: CreateRouteDto) {
    return this.admin.crearRecorrido(dto);
  }

  @Put('routes/:id')
  @ApiOperation({
    summary: 'Editar o archivar un recorrido',
    description:
      'Cambiar la geometría **no toca** las maratones que ya salieron de él: se llevaron su ' +
      'copia, y el trazado de una carrera corrida es historia, no configuración.',
  })
  @ApiResponse({ status: 200, type: RouteSummaryDto })
  editarRecorrido(@Param('id') id: string, @Body() dto: UpdateRouteDto) {
    return this.admin.actualizarRecorrido(id, dto);
  }

  @Delete('routes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar un recorrido que ninguna maratón usó',
    description: 'Con carreras detrás se niega: lo que corresponde es archivarlo.',
  })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'CONFLICT: hay maratones' })
  borrarRecorrido(@Param('id') id: string) {
    return this.admin.borrarRecorrido(id);
  }

  // ─── Maratones ───────────────────────────────────────────────────────────

  @Get('marathons')
  @ApiOperation({
    summary: 'Maratones, publicadas y borradores',
    description:
      'A diferencia del catálogo, aquí sí salen las no publicadas. Trae el estado declarado ' +
      '(`intent`) junto al resuelto (`resolved`), para que se entienda por qué una maratón ' +
      '"abierta" aparece llena.',
  })
  listarMaratones() {
    return this.admin.listarMaratones();
  }

  @Post('marathons')
  @ApiOperation({
    summary: 'Crear una maratón',
    description:
      'Nace **como borrador** salvo que se mande `published: true`: una carrera recién cargada ' +
      'suele tener la fecha provisional, y publicarla sola la metería en el catálogo antes de ' +
      'que nadie la revise. Sin `slug` se deriva del nombre y se desambigua con un sufijo. ' +
      'Con `routeId` la carrera **copia** el recorrido elegido (`GET /admin/routes`): trazado, ' +
      'distancia medida y punto de largada. En ese caso `distanceMeters` sobra.',
  })
  @ApiResponse({ status: 201, description: 'La maratón creada, con sus categorías y extras' })
  crearMaraton(@Body() dto: CreateMarathonDto) {
    return this.admin.crearMaraton(dto);
  }

  @Get('marathons/:id')
  @ApiOperation({
    summary: 'Detalle completo, con categorías y extras',
    description: 'Es lo que rellena el formulario de edición. Trae borradores, como todo aquí.',
  })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  verMaraton(@Param('id') id: string) {
    return this.admin.detalleMaraton(id);
  }

  @Put('marathons/:id')
  @ApiOperation({
    summary: 'Editar una maratón',
    description:
      'Parcial: lo que no venga en el cuerpo no se toca. `null` sí vacía el campo, que es ' +
      'distinto de no mandarlo.',
  })
  editarMaraton(@Param('id') id: string, @Body() dto: UpdateMarathonDto) {
    return this.admin.actualizarMaraton(id, dto);
  }

  @Post('marathons/:id/qr')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Subir el QR de cobro de la maratón',
    description:
      'Reemplaza el `paymentQrUrl` actual. Es el mismo QR para todos los inscritos que elijan ' +
      'pagar por QR: lo que distingue un cobro de otro es la glosa, no la imagen.',
  })
  @ApiResponse({ status: 415, type: ErrorResponseDto, description: 'INVALID_IMAGE' })
  subirQr(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Falta el archivo en el campo `file`',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.admin.subirQr(id, file);
  }

  @Delete('marathons/:id')
  @ApiOperation({
    summary: 'Borrar una maratón sin inscritos',
    description:
      'Con inscripciones **se niega**: el borrado en cascada se llevaría pagos, dorsales y ' +
      'resultados. Para una carrera vendida lo que corresponde es despublicarla.',
  })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'CONFLICT: tiene inscritos' })
  borrarMaraton(@Param('id') id: string) {
    return this.admin.borrarMaraton(id);
  }

  // ─── Categorías y extras ─────────────────────────────────────────────────

  @Post('marathons/:id/categories')
  @ApiOperation({ summary: 'Agregar una categoría a una maratón' })
  crearCategoria(@Param('id') id: string, @Body() dto: CreateCategoryDto) {
    return this.admin.crearCategoria(id, dto);
  }

  @Put('categories/:categoryId')
  @ApiOperation({ summary: 'Editar una categoría' })
  editarCategoria(@Param('categoryId') categoryId: string, @Body() dto: UpdateCategoryDto) {
    return this.admin.actualizarCategoria(categoryId, dto);
  }

  @Delete('categories/:categoryId')
  @ApiOperation({
    summary: 'Borrar una categoría',
    description:
      'Las inscripciones que la usaban **no se borran**: se quedan sin categoría, con su dorsal ' +
      'y su pago intactos. La respuesta dice cuántas quedaron así.',
  })
  borrarCategoria(@Param('categoryId') categoryId: string) {
    return this.admin.borrarCategoria(categoryId);
  }

  @Post('marathons/:id/extras')
  @ApiOperation({ summary: 'Agregar un adicional comprable' })
  crearExtra(@Param('id') id: string, @Body() dto: CreateExtraDto) {
    return this.admin.crearExtra(id, dto);
  }

  @Put('extras/:extraId')
  @ApiOperation({ summary: 'Editar un adicional', description: '`stock: null` = sin límite' })
  editarExtra(@Param('extraId') extraId: string, @Body() dto: UpdateExtraDto) {
    return this.admin.actualizarExtra(extraId, dto);
  }

  @Delete('extras/:extraId')
  @ApiOperation({
    summary: 'Borrar un adicional',
    description:
      'Lo ya vendido no se pierde: vive copiado en el `quoteSnapshot` de cada inscripción. ' +
      'Borrarlo solo significa que deja de poder comprarse.',
  })
  borrarExtra(@Param('extraId') extraId: string) {
    return this.admin.borrarExtra(extraId);
  }

  @Post('marathons/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publicar una maratón en el catálogo' })
  publicar(@Param('id') id: string) {
    return this.admin.publicar(id, true);
  }

  @Post('marathons/:id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sacarla del catálogo',
    description:
      'No cancela nada: las inscripciones vendidas siguen existiendo y sus dueños siguen ' +
      'viendo su carrera. Solo deja de aparecer en el catálogo.',
  })
  despublicar(@Param('id') id: string) {
    return this.admin.publicar(id, false);
  }

  // ─── Largada en vivo ─────────────────────────────────────────────────────

  @Post('marathons/:id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dar la largada',
    description:
      'Pone `liveStartedAt` con la hora del **servidor** y lo anuncia por el socket: es lo ' +
      'que hace que el móvil de cada inscrito abra la pantalla de carrera. Llamarlo dos ' +
      'veces no reinicia nada, la primera hora manda.',
  })
  largar(@Param('id') id: string) {
    return this.admin.largar(id, true);
  }

  @Post('marathons/:id/finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cortar la carrera',
    description:
      'Cierra la ventana en vivo: los móviles pasan al resumen con sus estadísticas y el ' +
      'mapa del panel deja de recibir posiciones.',
  })
  finalizar(@Param('id') id: string) {
    return this.admin.largar(id, false);
  }

  @Get('marathons/:id/live')
  @ApiOperation({
    summary: 'Foto de dónde va cada corredor ahora mismo',
    description:
      'Lo que el mapa necesita al **abrirse**; a partir de ahí las posiciones llegan por el ' +
      'socket. Solo dorsal y coordenada: nunca el nombre ni el id de la persona.',
  })
  enVivo(@Param('id') id: string) {
    return this.admin.posicionesEnVivo(id);
  }

  @Post('marathons/:id/close-registrations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar las inscripciones y recalcular el estado',
    description:
      '`registrationStatus` guarda la **intención** del admin y solo manda cuando dice ' +
      '`closed`; lo demás se deriva de cupos y fechas al leer.',
  })
  cerrar(@Param('id') id: string) {
    return this.admin.cerrarInscripciones(id, true);
  }

  @Post('marathons/:id/reopen-registrations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reabrir las inscripciones',
    description: 'Devuelve la columna a `open` y deja que los datos manden otra vez.',
  })
  reabrir(@Param('id') id: string) {
    return this.admin.cerrarInscripciones(id, false);
  }

  /**
   * El CSV sale como archivo y **fuera del sobre** `{ data, meta }`.
   *
   * Envolver un CSV en JSON obligaria al navegador a desenvolverlo con
   * JavaScript para poder descargarlo, y el punto de exportar es que el
   * organizador le de a un enlace y le salga el archivo.
   */
  @Get('marathons/:id/registrants.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Exportar los inscritos a CSV',
    description:
      'Confirmadas y pendientes de pago. Lleva BOM UTF-8 para que Excel no rompa los acentos, ' +
      'y las celdas que empiezan por `=` van neutralizadas: un CSV no debe ejecutar nada.',
  })
  @ApiResponse({ status: 200, description: 'Archivo CSV' })
  async exportar(@Param('id') id: string, @Res() res: Response) {
    const { filename, csv } = await this.admin.inscritosCsv(id);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  // ─── Inscripciones y pagos ───────────────────────────────────────────────

  @Get('registrations')
  @ApiQuery({ name: 'marathonId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: RegistrationStatus })
  @ApiOperation({ summary: 'Últimas inscripciones, filtrables' })
  listarInscripciones(
    @Query('marathonId') marathonId?: string,
    @Query('status') status?: RegistrationStatus,
  ) {
    return this.admin.listarInscripciones({ marathonId, status });
  }

  @Get('payments/pending-transfers')
  @ApiOperation({
    summary: 'Transferencias esperando confirmación manual',
    description: 'La bandeja de trabajo del admin: quién pagó por banco y falta darle el visto.',
  })
  transferenciasPendientes() {
    return this.admin.listarTransferenciasPendientes();
  }

  @Post('payments/:id/confirm-transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dar por cobrada una transferencia bancaria',
    description:
      'Toma el cupo y emite el dorsal en la misma transacción que un cobro normal: no hay una ' +
      'segunda forma de acreditar un pago. Solo aplica a `bank_transfer` y solo si sigue ' +
      '`pending`.',
  })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'PAYMENT_ALREADY_SETTLED' })
  confirmarTransferencia(
    @CurrentUser('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: ConfirmTransferDto,
  ) {
    return this.admin.confirmarTransferencia(id, adminId, dto.reference);
  }

  // ─── Resultados ──────────────────────────────────────────────────────────

  @Post('marathons/:id/results')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cargar los tiempos de una carrera y recalcular puestos',
    description:
      'Los resultados llegan **por dorsal**, que es como los entrega cualquier cronometraje. ' +
      'Un dorsal desconocido no tumba la carga: vuelve en `unknownBibs`. Es idempotente, y los ' +
      'puestos se recalculan una sola vez al final.',
  })
  @ApiResponse({ status: 200, type: ImportResultsResponseDto })
  importarResultados(@Param('id') id: string, @Body() dto: ImportResultsDto) {
    return this.admin.importarResultados(id, dto);
  }

  @Post('marathons/:id/recalculate-ranks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recalcular puestos sin tocar tiempos',
    description: 'Para después de corregir un tiempo a mano. Los empates comparten puesto.',
  })
  recalcular(@Param('id') id: string) {
    return this.admin.recalcularPuestos(id);
  }

  // ─── Usuarios ────────────────────────────────────────────────────────────

  @Get('users')
  @ApiQuery({ name: 'q', required: false, description: 'Busca por email o nombre' })
  @ApiOperation({
    summary: 'Usuarios, sin datos sensibles',
    description:
      'Ni hash de contraseña, ni tokens, ni ubicaciones: lo que no hace falta aquí no se ' +
      'consulta, y así no puede filtrarse por un descuido.',
  })
  listarUsuarios(@Query('q') q?: string) {
    return this.admin.listarUsuarios(q);
  }
  @Post('users')
  @ApiOperation({
    summary: 'Crear una cuenta',
    description:
      'Es la **única** forma de crear un administrador: el registro público crea `runner` y ' +
      'punto, porque un endpoint abierto que acepte `role` es un escalado de privilegios ' +
      'esperando a que alguien lo pruebe. El email queda verificado salvo que se diga lo ' +
      'contrario.',
  })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'EMAIL_ALREADY_REGISTERED' })
  crearUsuario(@Body() dto: CreateUserDto) {
    return this.admin.crearUsuario(dto);
  }

  @Put('users/:id')
  @ApiOperation({
    summary: 'Editar nombre, email, rol o verificación',
    description:
      'Un admin no puede quitarse a sí mismo el rol: sería dejar el panel sin nadie que pueda ' +
      'entrar. Que lo haga otro admin.',
  })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'CONFLICT / email ocupado' })
  editarUsuario(
    @CurrentUser('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.admin.actualizarUsuario(id, dto, adminId);
  }

  @Post('users/:id/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ponerle una contraseña nueva a alguien',
    description:
      '**Cierra todas sus sesiones.** Un reset que deja vivos los refresh tokens no sirve para ' +
      'lo único que se usa de verdad: sacar a quien no debería estar dentro.',
  })
  cambiarPassword(@Param('id') id: string, @Body() dto: SetPasswordDto) {
    return this.admin.cambiarPassword(id, dto.password);
  }

  @Delete('users/:id')
  @ApiOperation({
    summary: 'Borrar una cuenta',
    description:
      'Suelta los cupos de sus carreras futuras y borra sus archivos, igual que el borrado que ' +
      'pide el propio usuario: es el mismo camino, no una segunda implementación. Un admin no ' +
      'puede borrarse a sí mismo desde aquí.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'CONFLICT: es tu propia cuenta',
  })
  borrarUsuario(@CurrentUser('sub') adminId: string, @Param('id') id: string) {
    return this.admin.borrarUsuario(id, adminId);
  }
}
