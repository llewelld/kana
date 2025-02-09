var kanaDB;
var init = null;

export function initialize() {
  init = new Promise((resolve) => {
    // initialize database on worker creation
    kanaDB = indexedDB.open("KanaDB", 2);

    kanaDB.onupgradeneeded = (e) => {
      var kanaDBClient = e.target.result;

      // Currently purging all existing stores when the version is updated.
      // At some point we may add a more sophisticated upgrade mechanism.
      try {
        kanaDBClient.deleteObjectStore("analysis");
      } catch (e) {}
      try {
        kanaDBClient.deleteObjectStore("analysis_meta");
      } catch (e) {}
      try {
        kanaDBClient.deleteObjectStore("file");
      } catch (e) {}
      try {
        kanaDBClient.deleteObjectStore("file_meta");
      } catch (e) {}

      kanaDBClient.createObjectStore("analysis", { keyPath: "id" });
      kanaDBClient.createObjectStore("analysis_meta", { keyPath: "id" });
      kanaDBClient.createObjectStore("file", { keyPath: "id" });
      kanaDBClient.createObjectStore("file_meta", { keyPath: "id" });
    };

    // Send existing stored analyses, if available.
    kanaDB.onsuccess = () => {
      resolve(get_records());
    };

    kanaDB.onerror = () => {
      resolve(null);
    };
  });

  return init;
}

function get_records() {
  let store = kanaDB.result
      .transaction(["analysis_meta"], "readonly")
      .objectStore("analysis_meta");

  var allAnalysis = store.getAll();
  return new Promise((resolve, reject) => {
    allAnalysis.onsuccess = event => {
      let vals = allAnalysis.result;

      // no need to transfer the files themselves.
      vals.forEach((x) => {
        delete x.files;
      }); 

      resolve(vals);
    };
  
    allAnalysis.onerror = event => {
      reject(new Error(`failed to query the analysis store in KanaDB: ${event.target.errorCode}`));
    };
  });
}

export async function getRecords() {
  await init;
  return get_records();
}

/** Functions to save content **/

export async function saveFile(id, buffer) {
  await init;
  let trans = kanaDB.result.transaction(["file", "file_meta"], "readwrite");
  let fin = new Promise((resolve, reject) => {
    trans.oncomplete = (event) => {
      resolve(null);
    };
    trans.onerror = (event) => {
      reject(new Error(`transaction error when saving file ${id} in DownloadsDB: ${event.target.errorCode}`));
    };
  });

  let file_store = trans.objectStore("file");
  let meta_store = trans.objectStore("file_meta");

  let request = meta_store.get(id);
  let saving = new Promise((resolve, reject) => {
    request.onsuccess = event => {
      let meta = request.result;
      if (typeof meta === "undefined") {
        meta = { count: 1, id: id };
      } else {
        meta.count++;
      }

      var data_saving = new Promise((resolve, reject) => {
        var putrequest = file_store.put({ id: id, payload: buffer.buffer });
        putrequest.onsuccess = event => {
          resolve(true);
        };
        putrequest.onerror = event => {
          reject(new Error(`failed to save file ${id} in KanaDB: ${event.target.errorCode}`));
        };
      });

      var ref_saving = new Promise((resolve, reject) => {
        var putrequest = meta_store.put(meta);
        putrequest.onsuccess = event => {
          resolve(true);
        };
        putrequest.onerror = event => {
          reject(new Error(`failed to save metadata for file ${id} in KanaDB: ${event.target.errorCode}`));
        };
      });

      resolve(Promise.all([data_saving, ref_saving]));
    };

    request.onerror = event => {
      reject(new Error(`failed to retrieve metadata ${id} in KanaDB: ${event.target.errorCode}`));
    };
  });

  // Only await after attaching all event handlers.
  await fin;
  await saving;
  return;
}

export async function saveAnalysis(id, state, files, title) {
  await init;
  let trans = kanaDB.result.transaction(
    ["analysis", "analysis_meta"],
    "readwrite"
  );
  let fin = new Promise((resolve, reject) => {
    trans.oncomplete = (event) => {
      resolve(null);
    };
    trans.onerror = (event) => {
      reject(new Error(`transaction error when saving analysis ${id} in DownloadsDB: ${event.target.errorCode}`));
    };
  });

  let analysis_store = trans.objectStore("analysis");
  let meta_store = trans.objectStore("analysis_meta");

  let callback = new_id => {
    var data_saving = new Promise((resolve, reject) => {
      var putrequest = analysis_store.put({ id: new_id, payload: state.buffer });
      putrequest.onsuccess = event => {
        resolve(true);
      };
      putrequest.onerror = event => {
        reject(new Error(`failed to save analysis file ${new_id} in KanaDB: ${event.target.errorCode}`));
      };
    });

    var id_saving = new Promise((resolve, reject) => {
      var putrequest = meta_store.put({
        id: new_id,
        files: files,
        time: Number(new Date()),
        title: title,
      });
      putrequest.onsuccess = event => {
        resolve(true);
      };
      putrequest.onerror = event => {
        reject(new Error(`failed to save analysis metadata ${new_id} in KanaDB: ${event.target.errorCode}`));
      };
    });

    // DO NOT await the promises here!
    return [new_id, data_saving, id_saving];
  };

  let output_promise;
  if (id === null) {
    let request = meta_store.getAll();
    output_promise = new Promise((resolve, reject) => {
      request.onsuccess = event => {
        resolve(callback(String(request.result.length)));
      };
      request.onerror = event => {
        reject(new Error(`failed to list existing analysis store in KanaDB: ${event.target.errorCode}`));
      };
    });
  } else {
    output_promise = callback(id);
  }

  // Only await after attaching all event handlers.
  let output = await output_promise;
  await fin;
  return output[0];
}

/** Functions to load content **/

export async function loadFile(id) {
  await init;
  let file_store = kanaDB.result
    .transaction(["file"], "readonly")
    .objectStore("file");

  let meta_promise = new Promise((resolve, reject) => {
    let request = file_store.get(id);
    request.onsuccess = event => {
      resolve(request.result !== undefined ? request.result : null);
    };
    request.onerror = event => {
      reject(new Error(`failed to retrieve file ${id} from KanaDB: ${event.target.errorCode}`));
    };
  });

  var meta = await meta_promise;
  if (meta !== null) {
    meta = new Uint8Array(meta["payload"]);
  }
  return meta;
}

export async function loadAnalysis(id) {
  await init;
  let analysis_store = kanaDB.result
    .transaction(["analysis"], "readonly")
    .objectStore("analysis");

  let ana_promise = new Promise((resolve, reject) => {
    let request = analysis_store.get(id);
    request.onsuccess = event => {
      resolve(request.result !== undefined ? request.result : null);
    };
    request.onerror = event => {
      reject(new Error(`failed to retrieve analysis ${id} from KanaDB: ${event.target.errorCode}`));
    };
  });

  var meta = await ana_promise;
  if (meta !== null) {
    meta = new Uint8Array(meta["payload"]);
  }
  return meta;
}

/** Functions to remove content **/

async function superResolver(x) {
  let resolved = await x;
  if (resolved instanceof Array) {
    let replacement = [];
    for (const y of resolved) {
      replacement.push(await superResolver(y));
    }
    resolved = replacement;
  }
  return resolved;
}

function remove_file(id, file_store, meta_store) {
  let request = meta_store.get(id);

  return new Promise((resolve, reject) => {
    request.onsuccess = event => {
      let meta = request.result;
      var refcount = meta["count"] - 1;
      var promises = [];

      if (refcount === 0) {
        promises.push(
          new Promise((resolve, reject) => {
            let request = file_store.delete(id);
            request.onsuccess = event => {
              resolve(true);
            };
            request.onerror = event => {
              reject(new Error(`failed to remove file ${id} from KanaDB: ${event.target.errorCode}`));
            };
          })
        );
    
        promises.push(
          new Promise((resolve, reject) => {
            let request = meta_store.delete(id);
            request.onsuccess = event => {
              resolve(true);
            };
            request.onerror = event => {
              reject(new Error(`failed to remove file metadata ${id} from KanaDB: ${event.target.errorCode}`));
            };
          })
        );
  
      } else {
        promises.push(
          new Promise((resolve, reject) => {
            meta.count = refcount;
            let request = meta_store.put(meta);
            request.onsuccess = event => {
              resolve(true);
            };
            request.onerror = event => {
              reject(new Error(`failed to update file metadata ${id} in KanaDB: ${event.target.errorCode}`));
            };
          })
        );
      }

      resolve(promises);
    };

    request.onerror = event => {
      console.log(event);
      reject(new Error(`failed to retrieve file metadata ${id} from KanaDB: ${event.target.errorCode}`));
    };
  });
}

export async function removeFile(id) {
  await init;
  let trans = kanaDB.result.transaction(["file", "file_meta"], "readwrite");
  let fin = new Promise((resolve, reject) => {
    trans.oncomplete = (event) => {
      resolve(null);
    };
    trans.onerror = (event) => {
      reject(new Error(`transaction error when removing file ${id} in DownloadsDB: ${event.target.errorCode}`));
    };
  });

  let file_store = trans.objectStore("file");
  let meta_store = trans.objectStore("file_meta");
  let removal = remove_file(id, file_store, meta_store);

  // Only await after attaching all event handlers.
  await superResolver(removal);
  await fin;
  return;
}

export async function removeAnalysis(id) {
  await init;
  let trans = kanaDB.result.transaction(
    ["analysis", "analysis_meta", "file", "file_meta"],
    "readwrite"
  );
  let fin = new Promise((resolve, reject) => {
    trans.oncomplete = (event) => {
      resolve(null);
    };
    trans.onerror = (event) => {
      reject(new Error(`transaction error when removing analysis ${id} in DownloadsDB: ${event.target.errorCode}`));
    };
  });

  let analysis_store = trans.objectStore("analysis");
  let analysis_meta_store = trans.objectStore("analysis_meta");
  let file_store = trans.objectStore("file");
  let file_meta_store = trans.objectStore("file_meta");

  let analysis_removal = new Promise((resolve, reject) => {
    let request = analysis_store.delete(id);
    request.onsuccess = event => {
      resolve(true);
    };
    request.onerror = event => {
      reject(new Error(`failed to delete analysis ${id} from KanaDB: ${event.target.errorCode}`));
    };
  })

  // Removing all files as well.
  let request = analysis_meta_store.get(id);
  let file_removal = new Promise((resolve, reject) => {
    request.onsuccess = event => {
      let meta = request.result;

      let my_promises = [];
      for (const v of Object.values(meta["files"]["datasets"])) {
        for (const f of v["files"]) {
          my_promises.push(remove_file(f["id"], file_store, file_meta_store));
        }
      }

      // And THEN removing the analysis metadata, because otherwise
      // we wouldn't know what the files were, obviously!
      let deleted = new Promise((resolve, reject) => {
        let request = analysis_meta_store.delete(id);
        request.onsuccess = event => {
          resolve(true);
        };
        request.onerror = event => {
          reject(new Error(`failed to delete analysis metadata ${id} from KanaDB: ${event.target.errorCode}`));
        };
      })

      my_promises.push(deleted);
      resolve(my_promises);
    };

    request.onerror = event => {
      reject(new Error(`failed to retrieve analysis metadata ${id} from KanaDB: ${event.target.errorCode}`));
    };
  });

  // Only await after attaching all event handlers.
  await analysis_removal;
  await superResolver(file_removal);
  await fin;
  return true;
}
