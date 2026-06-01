import * as amazon from './amazon.js';
import * as bluesky from './bluesky.js';
import * as wikipedia from './wikipedia.js';
import * as branchIoDeeplinks from './branchio-deeplinks.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import * as twitter from './twitter.js';
import * as dlsite from './dlsite.js';
import * as iwara from './iwara.js';
import * as komiflo from './komiflo.js';
import * as nijie from './nijie.js';
import * as npmjs from './npmjs.js';
import * as nintendoStore from './nintendo-store.js';
import * as yodobashi from './yodobashi.js';
import * as sqex from './sqex.js';
import * as syosetu from './syosetu.js';
import * as kakuyomu from './kakuyomu.js';
import * as nitori from './nitori.js';
import * as dmm from './dmm.js';
import * as googleDrive from './google-drive.js';
import { SummalyPlugin } from '@/iplugin.js';

export const plugins: SummalyPlugin[] = [
	amazon,
	bluesky,
	wikipedia,
	branchIoDeeplinks,
	youtube,
	spotify,
	twitter,
	dlsite,
	iwara,
	komiflo,
	nijie,
	npmjs,
	nintendoStore,
	yodobashi,
	sqex,
	syosetu,
	kakuyomu,
	nitori,
	dmm,
	googleDrive,
];
