import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

/**
 * Local-disk image storage.
 *
 * AuthModule is required for AuthGuard (upload and delete are authenticated);
 * missing it fails at boot with an unresolved dependency rather than at request
 * time, which is why test/module-wiring.spec.ts compiles the real AppModule.
 * DatabaseModule supplies the row that makes a stored file reachable. No
 * AuditService: uploading your own picture is not an access or financial
 * change, and the row already records the owner and the time.
 */
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
