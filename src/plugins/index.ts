import * as amazon from './amazon.js';
import * as bluesky from './bluesky.js';
import * as wikipedia from './wikipedia.js';
import * as branchIoDeeplinks from './branchio-deeplinks.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import * as dlsite from './dlsite.js';
import * as iwara from './iwara.js';
import * as komiflo from './komiflo.js';
import * as nijie from './nijie.js';
import { SummalyPlugin } from '@/iplugin.js';

export const plugins: SummalyPlugin[] = [
	amazon,
	bluesky,
	wikipedia,
	branchIoDeeplinks,
	youtube,
	spotify,
	dlsite,
	iwara,
	komiflo,
	nijie,
];
