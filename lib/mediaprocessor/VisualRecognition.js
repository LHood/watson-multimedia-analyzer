'use strict';
/*
* Copyright 2016 IBM Corp. All Rights Reserved.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*      http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
const request = require('request');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('ytdl-core');
const tmp = require('tmp');
const uuid = require('node-uuid');
const inspect = require('util').inspect;
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const watson = require('watson-developer-cloud');
const log = require('pino')();
log.level = 'debug';

const cfenv = require('cfenv');
const appEnv = cfenv.getAppEnv();
const localMediaURL = 'http://enrich:enrichit@' + appEnv.bind + ':' + appEnv.port + '/';

require('dotenv').load({
  silent: true
})

var vr_params = {
  api_key: process.env.VR_KEY,
  version: 'v3',
  version_date: '2016-05-20'
};

var visual_recognition = null;

const screenshotDir = './screenshots';

// Return a timestamp from file
function getTimeStamp(filename) {
  var m = filename.match(/\S+\-(\S+)\.png$/);
  return (m) ? m[1] : null;
}

// Delete a file
function deleteFile(filename) {
  try {
    fs.unlink(filename);
  } catch (e) {
    log.error('deleteFile failed: ', e);
  }
}

// Classify an image w/ VR
function classifyVR(filename) {
  log.debug('calling classifyVR: ', filename);
  return new Promise((resolve, reject) => {
    //      params.classifier_ids = ["main_characters_175558967"];
    //      params.threshold = 0.2;
    var params = {};
    try {

      params.images_file = fs.createReadStream(filename);
      //      params.classifier_ids = ["default","Scott_1448984388","Allison_443507375","Derek_2022646475","Stiles_718422474","Scott_Werewolf_617536460","Lydia_886968429"];
    } catch (e) {
      reject(e);
    }
    log.debug('calling visual_recognition classify', params)
    visual_recognition.classify(params, function(err, res) {
      if (err) {
        //        log.debug('classifyVR: ' + filename, err);
        reject(err)
      } else {
        //       log.debug('classifyVR: finished');
        res.images.forEach((img) => {
          img.time = getTimeStamp(img.image);
        })
        resolve(res);
      }
    })
  })
}

// Call detectFaces VR
function detectFacesVR(filename) {
  //log.debug('calling detectFacesVR');
  return new Promise((resolve, reject) => {
    var params = {};
    try {
      params.images_file = fs.createReadStream(filename);
    } catch (e) {
      reject(e);
    }
    visual_recognition.detectFaces(params, function(err, res) {
      if (err) {
        log.debug('detectFacesVR: ' + filename, err);
        reject(err)
      } else {
        //log.debug('detectFacesVR finished');
        res.images.forEach((img) => {
          img.time = getTimeStamp(img.image);
        })
        resolve(res);
      }
    })
  });
}

// call RecognizeText
function recognizeTextVR(filename) {
  //log.debug('calling recognizeTextVR');
  return new Promise((resolve, reject) => {
    var params = {};
    try {
      params.images_file = fs.createReadStream(filename);
    } catch (e) {
      reject(e);
    }
    visual_recognition.recognizeText(params, function(err, res) {
      if (err) {
        log.debug('recognizeTextVR: ' + filename, err);
        reject(err)
      } else {
        //log.debug('imageKeyworkdsVR finished');
        res.images.forEach((img) => {
          img.time = getTimeStamp(img.image);
        })
        resolve(res);
      }
    })
  });
}

// Merge results into single JSON
function mergeImageRecognition(a) {
  // This is two objects, we want to merge the ones in faces array.
  var classify = a[0];
  var faces = a[1];
  var text = a[2];
  if (classify.images.length === 1 && faces.images.length == 1) {
    Object.assign(classify.images[0], faces.images[0]);
    if (text.images.length === 1) {
      Object.assign(classify.images[0], text.images[0])
    }
  }
  //log.debug(inspect(classify, {color: true, depth: null}));
  return classify;
}

// Execute all of the VR on a file.
function combinedVR(filename) {
  var combo = [];
  return new Promise((resolve, reject) => {
    classifyVR(filename)
      .then((classify) => {
        log.debug('Classify Finished: ', classify);
        combo.push(classify);
        return detectFacesVR(filename)
      })
      .then((faces) => {
        combo.push(faces);
        log.debug('faces: ', faces);
        return recognizeTextVR(filename)
      })
      .then((imagetext) => {
        // log.debug('Finished combinedVR')
        combo.push(imagetext);
        //       log.debug('COMBO! =========');
        //        log.debug(inspect(combo, {color:true, depth: null}));
        resolve(mergeImageRecognition(combo));
      })
      .catch(reject)
  })
}

// Create a Zip file from a list of files. Goal here is to make 
// VR work better
function zipList(files) {
  return new Promise((resolve, reject) => {
    var zip = archiver('zip');
    var outfile = screenshotDir + '/' + uuid.v1() + '.zip';
    var outfilestream = fs.createWriteStream(outfile);
    zip.pipe(outfilestream);
    files.forEach((file) => {
      log.debug('adding file to zip');
      try {
        zip.append(fs.createReadStream(file), {
          name: path.basename(file)
        });
      } catch (e) {
        log.error(e)
      }
    })
    var filesadded = 0;
    zip.on('entry', () => {
      filesadded++;
      if (filesadded === files.length) {
        // Done processing the files.
        zip.finalize();
        resolve(outfile)
      }
    })

    zip.on('error', (error) => {
        log.error('Zip Failed? ', error);
        reject(error);
      })
      /*
      setTimeout(function() {
        log.debug('Calling finalize'+files[0]);
        zip.finalize()
        log.debug('Called finalize'+files[0]);
        resolve(outfile);
      },500)
      */
  })
}

// Chunk list of files into a smaller lists
function chunkList(list, size) {
  var chunked = [];
  // How many chunks we will have
  var chunks = parseInt(list.length / size) + 1;
  for (var i = 0; i < chunks; i++) {
    // first i is 0; 
    chunked.push(list.slice(i * size, (i + 1) * size))
  }
  return chunked;
}

// Zip to 15 files
function zipTo15(filelist) {
  // This is the max number of files for face recognition...
  var chunkSize = 15;
  var chunkedList = chunkList(filelist, chunkSize);
  return Promise.all(chunkedList.map((list) => {
    return zipList(list);
  }));
}

// Resolve the media -- if it is a Youtube video, we have to 
// download it and then pass it through VR.
function resolveMedia(metadata) {
  return new Promise((resolve, reject) => {
    if (metadata.yt_info) {
      // is youtube
      log.debug('resolveMedia - downloading from youtube');
      tmp.file({
        discardDescriptor: true
      }, function _tempFileCreated(err, path, fd, cleanupCallback) {
        log.debug('resolveMedia downloading file to tmpfile: ', path);
        ytdl.downloadFromInfo(metadata.yt_info, {
            format: 43
          })
          .pipe(fs.createWriteStream(path))
          .on('finish', (f) => {
            log.debug('ytdownload - downloading from youtube finished: ' + path);
            resolve(path)
          })
      });
    } else {
      // Make sure we are accessing this from a URL
      if (metadata.content.url.search('http') < 0 ) {
        resolve(localMediaURL + metadata.content.url )
      } else {
         resolve(metadata.content.url);
      }
    }
  })
}

// Givent a Mediafile, get the screenshots for the times
function getScreenCaps(mediafile,guid, times) {
  const dir = screenshotDir;
  var filenames = null;
  var key = guid;
  // If media isYoutube we have to do something different.
  log.debug('Outputing to: ', dir);
  return new Promise((resolve, reject) => {
    log.debug('visualRecognition: Getting Screen Shots');
    if (times.length === 0) {
      log.debug('visualRecognition: Nothing to do...');
      resolve([]);
    }

    log.debug('getScreenCaps: '+ __dirname);
    log.debug('getScreenCaps: file is: '+ mediafile );

    ffmpeg(mediafile)
      .on('start', (commandLine) => {
        log.debug('getScreenCaps: Spawned FFmpeg w/ command: ' + commandLine);
      })
      .on('codecData', function(data) {
        log.debug(data);
        log.debug('Input is ' + data.audio + ' audio ' + 'with ' + data.video + ' video');
      })
      .on('filenames', (files) => {
        log.debug(`getScreenCaps generated list of files: ${files.length}`);
        filenames = files;
      })
      .on('error', (error) => {
        log.error(`getScreenCaps error`, error);
        reject(error);
      })
      .on('end', () => {
        log.debug(`getScreenCaps: got ${filenames.length} Screen Shots`);
        resolve(filenames.map((file) => {
          return dir + '/' + file
        }))
      })
      .screenshots({
        timestamps: times,
        folder: dir,
        filename: '__sh-' + key + '-%s.png',
        size: '640x360'
      })
  })
}

// Given a file list, VR the whole list.
function vrFilelist(filelist) {
  var final_results = [];
  return new Promise((resolve, reject) => {
    log.debug('vrFilelist: Finished Collecting Screen Shots! ' + filelist.length);
    var params = {
      images_file: ''
    };
    if (filelist) {
      var errors = 0;
      var classified = 0;
      for (let index = 0; index < filelist.length; index++) {
        combinedVR(filelist[index])
          .then((res) => {
            final_results.push(res);
            if (classified === filelist.length - 1) {
              log.debug('vrFilelist:  Resolving promise');
              resolve(final_results);
            }
            classified++;
            // remove the file when finished
            log.debug('Finished with file: ' + filelist[index]);
            deleteFile(filelist[index]);
          })
          .catch((error) => {
            // If one of the combined VR rejects, ignore it...
            log.error(`A CombinedVR failed: ${classified}/${errors}/${index}`);
            log.error('A CombinedVR failed: ', error);
            // Remove file when finished
            deleteFile(filelist[index]);
            classified++;
            errors++;
            if (classified + errors >= index) {
              log.debug(`vrFileList: resolving promise(classified/errors/total): ${classified}/${errors}/${index}`);
              resolve(final_results);
            }
            // If everything is an error reject
            if (errors === index) {
              reject(new Error(`vrFileList Failed ${errors} with ${error.msg}`));
            }
          });
      }
    }
  })
}

// Main exposed API -- Given mediametadata, and times, VR it.
function visualRecognition(mediaMetadata, times, enrich, vr_key) {
  var final_results = [];
  if (vr_key) {
    vr_params.api_key = vr_key;
  }
  // Init visual_recognition
  visual_recognition = watson.visual_recognition(vr_params);
  return resolveMedia(mediaMetadata)
    .then((media) => {
      return getScreenCaps(media, mediaMetadata.guid, times)
    })
    //    .then(zipTo15)
    .then(vrFilelist)
    .catch((error) => {
      log.error('visualRecognition got an Error ', error)
    })
}
/*
  // called to enrich text
  enrichText(text, callback) {
    let data = { 'text' :'', 'stt_data': ''};

    if (typeof text === 'string') {
      data.text = text;
    } else if (typeof text === 'object') {
      data = text;
    } else {
      log.debug('Unknown text type for enrichment');
    }
    // Every timer, we do this
    // Save the text to the finalTranscript
  }
*/
module.exports = {
  visualRecognition: visualRecognition,
  chunkList: chunkList,
  zipList: zipList
};