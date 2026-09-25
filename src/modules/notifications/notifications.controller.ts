import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

export class PushTokenDto {
  @ApiProperty({ description: 'El mismo `deviceId` que se manda al iniciar sesion' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceId!: string;

  @ApiProperty({ description: 'Token de FCM de esta instalacion' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}

/** La bandeja de la campana. Cada usuario ve solo la suya. */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis notificaciones (las 50 ultimas) y cuantas no lei' })
  list(@CurrentUser('sub') userId: string) {
    return this.notifications.list(userId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marcar todas como leidas' })
  markAllRead(@CurrentUser('sub') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  @Put('push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Registra el token de FCM de este telefono' })
  setPushToken(@CurrentUser('sub') userId: string, @Body() dto: PushTokenDto) {
    return this.notifications.setPushToken(userId, dto.deviceId, dto.token);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marcar una como leida' })
  markRead(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }
}
