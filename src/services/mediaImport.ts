import { Types } from 'mongoose';
import { Media } from '../models/Media';
import { Memory } from '../models/Memory';
import { Video } from '../models/Video';
import { AudioMemory } from '../models/AudioMemory';
import { User } from '../models/User';
import { getSharedFamilyUser } from '../middleware/auth';
import { getClient, getVerifiedUploadFromFile } from './imagekitService';

const PAGE = 1000;

/** "1001259405_YMqKXJlhc.mp4" -> "1001259405" (drops ImageKit's unique suffix and the extension) */
function titleFrom(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/_[A-Za-z0-9_-]{9}$/, '');
  return base.replace(/[_]+/g, ' ').trim() || 'Untitled';
}

async function findOwner(): Promise<Types.ObjectId | null> {
  if (process.env.OPEN_ACCESS === 'true') return (await getSharedFamilyUser())._id as Types.ObjectId;
  const admin = await User.findOne({ role: 'admin', isActive: true }).sort({ createdAt: 1 });
  return admin ? (admin._id as Types.ObjectId) : null;
}

/**
 * Adds files already uploaded to ImageKit (under /users) that this database does not know about,
 * and publishes them to the album. Safe to run repeatedly: known files are skipped.
 */
export async function importImageKitMedia(): Promise<{ imported: number; skipped: number }> {
  const owner = await findOwner();
  if (!owner) return { imported: 0, skipped: 0 };

  const client = getClient();
  let imported = 0;
  let skipped = 0;
  for (let skip = 0; ; skip += PAGE) {
    const page = await client.assets.list({ type: 'file', fileType: 'all', limit: PAGE, skip });
    for (const asset of page) {
      if (!('fileId' in asset) || !asset.fileId || !asset.filePath?.startsWith('/users/')) continue;
      if (await Media.exists({ fileId: asset.fileId })) {
        skipped += 1;
        continue;
      }
      const upload = getVerifiedUploadFromFile(asset);
      if (!upload) continue; // not a private photo, video or audio file in a user folder

      await Media.create({ ...upload, userId: owner });
      const shared = { title: titleFrom(upload.name), mediaUrl: upload.url, thumbnailUrl: upload.thumbnailUrl, uploadedBy: owner };
      if (upload.fileType === 'image') {
        await Memory.create({ ...shared, mediaType: 'photo', category: 'Family', fileSize: upload.size, mimeType: upload.mimeType });
      } else if (upload.fileType === 'video') {
        await Video.create({ ...shared, category: 'Family', fileSize: upload.size });
      } else {
        await AudioMemory.create({ title: shared.title, mediaUrl: upload.url, uploadedBy: owner, duration: 0 });
      }
      imported += 1;
    }
    if (page.length < PAGE) break;
  }
  return { imported, skipped };
}
