import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ShoesService } from './shoes.service';
import { CreateShoeDto, ShoeDto, UpdateShoeDto } from './dto/shoe.dto';

class ListShoesQueryDto {
  /** En query todo llega como texto; `transform` del pipe no adivina booleanos. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeRetired?: boolean;
}

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users/me/shoes')
export class ShoesController {
  constructor(private readonly shoes: ShoesService) {}

  @Get()
  @ApiOperation({ summary: 'Zapatillas del usuario, la principal primero' })
  @ApiQuery({ name: 'includeRetired', required: false, type: Boolean })
  @ApiResponse({ status: 200, type: [ShoeDto] })
  list(@CurrentUser('sub') userId: string, @Query() query: ListShoesQueryDto) {
    return this.shoes.list(userId, query.includeRetired ?? false);
  }

  @Post()
  @ApiOperation({
    summary: 'Registra un par',
    description: 'La primera zapatilla en uso queda como principal automaticamente.',
  })
  @ApiResponse({ status: 201, type: ShoeDto })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateShoeDto) {
    return this.shoes.create(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita un par, lo retira o lo marca como principal',
    description: 'Marcar principal desmarca el anterior en la misma transaccion.',
  })
  @ApiResponse({ status: 200, type: ShoeDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  update(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: UpdateShoeDto) {
    return this.shoes.update(userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Borra un par',
    description:
      'Borrado real: el kilometraje de la zapatilla es un contador, y los entrenamientos guardan ' +
      'su propia distancia. Para conservar el historial de uso, retirala en vez de borrarla.',
  })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  remove(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.shoes.remove(userId, id);
  }
}
