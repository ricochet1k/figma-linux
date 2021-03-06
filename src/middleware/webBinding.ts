import * as Settings from "electron-settings";
import * as E from "electron";
import * as path from "path";
import * as fs from "fs";

import { sendMsgToMain, registerCallbackWithMainProcess } from "Utils/Render";
import { isMenuItem } from "Utils/Common";
import { postPromiseMessageToMainProcess } from "Utils/Render";
import { shortcutsMap } from "Utils/Render/ShortcutsMap";
import shortcutBinding from "./shortcutBinding";
import { ShortcutMan } from "./ShortcutMan";
import shortcuts from "Utils/Render/shortcuts";

// import api from "./webApi";

interface IntiApiOptions {
  version: number;
  fileBrowser: boolean;
  shortcutBinding?: any;
  shortcutsMap?: ShortcutsMap[];
  shortcutMan?: any;
}

const API_VERSION = 20;
let webPort: MessagePort;
let fontMap: any = null;
let resolveFontMapPromise: any = null;
const mainProcessCancelCallbacks: Map<number, Function> = new Map();
const fontMapPromise = new Promise(resolve => {
  resolveFontMapPromise = resolve;
});

const onClickExportImage = (e: Event, link: HTMLLinkElement) => {
  E.remote.net
    .request(`${link.href}`)
    .on("response", res => {
      const filetype: string = res.headers["content-type"][0].replace(/^.+\//, "");
      console.log("response file type: ", filetype);

      const savePath = E.remote.dialog.showSaveDialogSync({
        defaultPath: `${Settings.get("app.exportDir")}/${link.textContent.replace(/\..+$/, "")}.${filetype}`,
        showsTagField: false,
      });

      if (!savePath) return;

      let length = 0;
      const stream = fs.createWriteStream(savePath);

      res.on("data", chunk => {
        stream.write(chunk);

        if (chunk.length < length) {
          stream.end();
        }

        length = chunk.length;
      });
      res.on("error", (err: Error) => {
        console.log("Export image error: ", err);
      });
    })
    .on("error", error => console.log("request error: ", error))
    .end();

  e.preventDefault();
};

const onWebMessage = (event: MessageEvent) => {
  const msg = event.data;

  if (!msg) return;

  if (msg.callbackID != null) {
    const cancel = registerCallbackWithMainProcess(msg.name, msg.args, (args: any) => {
      webPort.postMessage({ args, callbackID: msg.callbackID });
    });
    mainProcessCancelCallbacks.set(msg.callbackID, cancel);
    return;
  }
  if (msg.cancelCallbackID != null) {
    mainProcessCancelCallbacks.get(msg.cancelCallbackID)();
    mainProcessCancelCallbacks.delete(msg.cancelCallbackID);
    return;
  }
  if (!msg.name || !(msg.name in publicAPI)) {
    console.error("[desktop] Unhandled message", msg.name);
    return;
  }

  let resultPromise = undefined;

  try {
    if (msg.name != "setPluginMenuData")
      console.log("onWebMessage, msg: ", msg.name, msg.args);
    resultPromise = msg.name && publicAPI && publicAPI[msg.name](msg.args);
  } catch (e) {
    console.error("onWebMessage, err: ", e);
    throw e;
  } finally {
    if (msg.promiseID != null) {
      if (resultPromise instanceof Promise) {
        resultPromise
          .then(result => {
            webPort.postMessage({ result: result.data, promiseID: msg.promiseID }, result.transferList);
          })
          .catch(error => {
            const errorString = (error && error.name) || "Promise error";
            webPort.postMessage({ error: errorString, promiseID: msg.promiseID });
          });
      } else {
        webPort.postMessage({ error: "No result" + resultPromise, promiseID: msg.promiseID });
      }
    }
  }
};

// TODO: (translated) Move a piece of code into separate scripts,
// then to collect from webpack in 1 js file
// and pass it to the executeJavaScript function
const initWebApi = (props: IntiApiOptions) => {
  const channel = new MessageChannel();
  const pendingPromises = new Map();
  const registeredCallbacks = new Map();

  let messageHandler: Function;
  let nextPromiseID = 0;
  let nextCallbackID = 0;
  const messageQueue: any[] = [];

  // console.log('args: ', args, args.shortcutMan);
  // const shortcutBinding = new Function(`return ${args.shortcutBinding}`);
  // console.log('args.shortcutBinding: ', `return ${args.shortcutBinding}`);
  // console.log('shortcutBinding(args.shortcutsMap): ', shortcutBinding()(args.shortcutsMap, args.shortcutMan));

  const tryFlushMessages = () => {
    if (messageHandler) {
      while (true) {
        const msg = messageQueue.shift();
        if (!msg) {
          break;
        }
        messageHandler(msg.name, msg.args);
      }
    }
  };

  window.__figmaContent = false;

  console.log("args.fileBrowser: ", typeof props.fileBrowser, props.fileBrowser);

  if (/file\/.+/.test(location.href)) {
    props.fileBrowser = false;
  }

  window.__figmaDesktop = {
    version: props.version,
    fileBrowser: props.fileBrowser,
    postMessage: function (name, args, transferList) {
      // console.log("postMessage, name, args, transferList: ", name, args, transferList);

      // FIXME: ugly hack
      if (!/recent/.test(window.location.href) && name === "updateActionState") {
        console.log("postMessage ugly hack: ", name, args);
        const state = {
          "save-as": true,
          "export-selected-exportables": true,
          "toggle-grid": true,
          "toggle-shown-layout-grids": true,
          "toggle-show-masks": true,
          "toggle-show-artboard-outlines": true,
          "toggle-rulers": true,
          "toggle-sidebar": true,
          "toggle-ui": true,
          "toggle-outlines": true,
          "toggle-layers": true,
          "toggle-publish": true,
          "toggle-library": true,
          "toggle-pixel-preview": true,
          "toggle-checkerboard": true,
          "zoom-in": true,
          "zoom-out": true,
          "zoom-reset": true,
          "zoom-to-fit": true,
          "zoom-to-selection": true,
          "next-artboard": true,
          "previous-artboard": true,
        };

        args = { state: { ...args.state, ...state } };
      }

      channel.port1.postMessage({ name, args }, transferList);
    },
    registerCallback: function (name, args, callback) {
      const id = nextCallbackID++;
      registeredCallbacks.set(id, callback);
      channel.port1.postMessage({ name, args, callbackID: id });
      return () => {
        registeredCallbacks.delete(id); // TODO: is it okay to delete this? will it ever be needed after cancelled?
        channel.port1.postMessage({ cancelCallbackID: id });
      };
    },
    promiseMessage: function (name, args, transferList) {
      return new Promise((resolve, reject) => {
        const id = nextPromiseID++;
        pendingPromises.set(id, { resolve, reject });
        channel.port1.postMessage({ name, args, promiseID: id }, transferList);
      });
    },
    setMessageHandler: function (handler) {
      messageHandler = handler;
      tryFlushMessages();
    },
  };

  channel.port1.onmessage = (event: MessageEvent) => {
    const msg = event.data;

    if (!msg) return;

    console.log("webBinding channel.port1.onmessage, event.data: ", event.data);

    if (msg.promiseID != null) {
      const pendingPromise = pendingPromises.get(msg.promiseID);

      if (pendingPromise) {
        pendingPromises.delete(msg.promiseID);
        if ("result" in msg) {
          pendingPromise.resolve(msg.result);
        } else {
          pendingPromise.reject(msg.error);
        }
      }
    } else if (msg.callbackID != null) {
      const registeredCallback = registeredCallbacks.get(msg.callbackID);
      if (registeredCallback) {
        registeredCallback(msg.args);
      } else {
        console.log("callback missing? ", msg);
      }
    } else if (msg.name != null) {
      messageQueue.push(msg);
      tryFlushMessages();
    }
  };

  window.postMessage("init", location.origin, [channel.port2]);
};

const initWebBindings = () => {
  setInterval(() => {
    const link: HTMLLinkElement = document.querySelector('div[class^="code_inspection_panels--inspectorRow"] > a');
    link &&
      (link.onclick = (e: Event) => {
        onClickExportImage(e, link);
      });
  }, 500);

  E.ipcRenderer.on("newFile", () => {
    webPort.postMessage({ name: "newFile", args: {} });
  });
  E.ipcRenderer.on("handleAction", (event: Event, action: string, source: string) => {
    webPort.postMessage({ name: "handleAction", args: { action, source } });
  });
  E.ipcRenderer.on("handlePageCommand", (event: Event, command: string) => {
    const fullscreenFocusTargetFocused =
      document.activeElement && document.activeElement.classList.contains("focus-target");
    if (fullscreenFocusTargetFocused) {
      let action = null;
      switch (command) {
        case "redo":
        case "undo":
          action = command;
          break;
        case "selectAll":
          action = "select-all";
          break;
      }

      if (action) {
        webPort.postMessage({ name: "handleAction", args: { action, source: "os-menu" } });
      }
    } else {
      document.execCommand(command);
    }
  });

  E.ipcRenderer.on("updateFonts", (event: Event, fonts: any) => {
    fontMap = fonts;
    if (resolveFontMapPromise) {
      resolveFontMapPromise();
      resolveFontMapPromise = null;
    }
  });

  E.ipcRenderer.on("handlePluginMenuAction", (event: Event, pluginMenuAction: any) => {
    webPort.postMessage({ name: "handlePluginMenuAction", args: { pluginMenuAction } });
  });
};

const publicAPI: any = {
  setTitle(args: any) {
    sendMsgToMain("setTabUrl", window.location.href);
    sendMsgToMain("setTitle", args.title);
  },

  setUser(args: any) {
    console.log("unimplemented setUser, args: ", args);
  },

  async getFonts() {
    return { data: await fontMapPromise };
  },

  newFile(args: any) {
    sendMsgToMain("newFile", args.info);
  },
  openFile(args: any) {
    sendMsgToMain("openTab", "/file/" + args.fileKey, args.title, undefined, args.target);
  },
  close(args: any) {
    sendMsgToMain("closeTab", args.suppressReopening);
  },
  setFileKey(args: any) {
    sendMsgToMain("updateFileKey", args.fileKey);
  },
  setLoading(args: any) {
    sendMsgToMain("updateLoadingStatus", args.loading);
  },
  setSaved(args: any) {
    sendMsgToMain("updateSaveStatus", args.saved);
  },
  updateActionState(args: any) {
    sendMsgToMain("updateActionState", args.state);
  },
  showFileBrowser() {
    sendMsgToMain("showFileBrowser");
  },
  setIsPreloaded() {
    sendMsgToMain("setIsPreloaded");
  },
  setPluginMenuData(args: WepApi.SetPluginMenuDataProps) {
    const pluginMenuData = [];
    for (const item of args.data) {
      if (isMenuItem(item)) {
        pluginMenuData.push(item);
      } else {
        console.error("[desktop] invalid plugin menu item", args);
      }
    }

    sendMsgToMain("setPluginMenuData", pluginMenuData);
  },

  async createMultipleNewLocalFileExtensions(args: any) {
    const result = await postPromiseMessageToMainProcess(
      "createMultipleNewLocalFileExtensions",
      args.options,
      args.depth,
    );
    return { data: result };
  },
  async getAllLocalFileExtensionIds() {
    const list = await postPromiseMessageToMainProcess("getAllLocalFileExtensionIds");
    return { data: list };
  },
  async getLocalFileExtensionManifest(args: any) {
    const manifest = await postPromiseMessageToMainProcess("getLocalFileExtensionManifest", args.id);
    return { data: manifest };
  },
  async getLocalFileExtensionSource(args: any) {
    const source = await postPromiseMessageToMainProcess("getLocalFileExtensionSource", args.id);
    return { data: source };
  },
  removeLocalFileExtension(args: any) {
    console.log("unimplemented removeLocalFileExtension", args);
    sendMsgToMain('removeLocalFileExtension', args.id);
  },
  openExtensionDirectory(args: any) {
    console.log("unimplemented openExtensionDirectory", args);
    sendMsgToMain('openExtensionDirectory', args.id);
  },
  async writeNewExtensionToDisk(args: any) {
    // args looks like {dirName: "user-typed plugin name", files: [
    //   {name: "filename.js", content: "filecontents"}
    // ]}
    // TODO: data is supposed to be the extensionId of the new extension!
    console.log("unimplemented writeNewExtensionToDisk", args);
    const extId = await postPromiseMessageToMainProcess("writeNewExtensionToDisk", args);
    return { data: extId };
  },

  async isDevToolsOpened(...args: any[]) {
    console.log("unimplemented isDevToolsOpened, args: ", args);
    return { data: true };
  },

  getFontFile(args: any) {
    return new Promise((resolve, reject) => {
      const fontPath = args.path;

      if (!fontMap) {
        reject(new Error("No fonts"));
        return;
      }

      const faces = fontMap[fontPath];
      if (!faces || faces.length === 0) {
        reject(new Error("Invalid path"));
        return;
      }

      let postScriptName = faces[0].postscript;
      try {
        postScriptName = args.postscript;
      } catch (ex) { }

      fs.readFile(fontPath, (err, data) => {
        if (err) {
          reject(err);
          return;
        }

        if (data.byteLength > 0) {
          resolve({ data: data.buffer, transferList: [data.buffer] });
          return;
        }

        reject(new Error("No data"));
      });
    });
  },

  getClipboardData(args: any) {
    return new Promise((resolve, reject) => {
      if (E.clipboard.has("org.nspasteboard.ConcealedType")) {
        reject(new Error("Clipboard unavailable"));
        return;
      }

      const whitelistedFormats = ["com.adobe.pdf", "com.adobe.xd", "com.bohemiancoding.sketch.v3"];

      const formats = args.getArray("formats");

      for (const format of formats) {
        let data = null;

        if (format === "text/html") {
          const unsafeHTML = E.clipboard.readHTML().trim();

          if (unsafeHTML.includes("<!--(figma)") && unsafeHTML.includes("(/figma)-->")) {
            data = new Buffer(unsafeHTML);
          }
        } else if (format === "image/svg+xml") {
          data = E.clipboard.readBuffer(format);
          data = data.byteLength > 0 ? data : E.clipboard.readBuffer("Scalable Vector Graphics");
          data = data.byteLength > 0 ? data : E.clipboard.readBuffer("CorePasteboardFlavorType 0x53564720");

          if (data.byteLength === 0) {
            const unsafeText = E.clipboard.readText().trim();
            if (unsafeText.startsWith("<svg") && unsafeText.endsWith("</svg>")) {
              data = new Buffer(unsafeText);
            }
          }
        } else if (format === "image/jpeg" || format === "image/png") {
          data = E.clipboard.readImage().toBitmap();
        } else if (whitelistedFormats.indexOf(format) !== -1) {
          data = E.clipboard.readBuffer(format);
        }

        if (data && data.byteLength > 0) {
          const result = {
            data: data.buffer,
            format: format,
          };

          resolve({ data: result, transferList: [data.buffer] });
          return;
        }
      }
      reject(new Error("Formats not found"));
    });
  },

  setClipboardData(args: any) {
    const format = args.format;
    const data = Buffer.from(args.data);

    if (["image/jpeg", "image/png"].indexOf(format) !== -1) {
      E.clipboard.writeImage(E.remote.nativeImage.createFromBuffer(data));
    } else if (format === "image/svg+xml") {
      E.clipboard.writeText(data.toString());
    } else if (format === "application/pdf") {
      E.clipboard.writeBuffer("Portable Document Format", data);
    } else {
      E.clipboard.writeBuffer(format, data);
    }
  },

  writeFiles(args: any) {
    console.log("writeFiles args: ", args);
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) return;

    let skipReplaceConfirmation = false;
    let directoryPath;
    if (files.length === 1 && !files[0].name.includes(path.sep)) {
      const originalFileName = files[0].name;
      const savePath = E.remote.dialog.showSaveDialogSync({
        defaultPath: `${Settings.get("app.exportDir")}/${originalFileName}`,
        showsTagField: false,
      });

      if (savePath) {
        directoryPath = path.dirname(savePath);
        files[0].name = path.basename(savePath);

        if (path.extname(files[0].name) === "") {
          files[0].name += path.extname(originalFileName);
        } else {
          skipReplaceConfirmation = true;
        }
      }
    } else {
      const directories = E.remote.dialog.showOpenDialogSync({
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "Save",
      });

      if (!directories || directories.length !== 1) {
        return;
      }
      directoryPath = directories[0];
    }

    if (!directoryPath) return;

    directoryPath = path.resolve(directoryPath);
    let filesToBeReplaced = 0;
    for (const file of files) {
      const outputPath = path.join(directoryPath, file.name);
      const validExtensions = [".fig", ".jpg", ".pdf", ".png", ".svg"];
      if (
        path.relative(directoryPath, outputPath).startsWith("..") ||
        !validExtensions.findIndex(i => i === path.extname(outputPath))
      ) {
        E.remote.dialog.showMessageBoxSync({
          type: "error",
          title: "Export Failed",
          message: "Export failed",
          detail: `"${outputPath}" is not a valid path. No files were saved.`,
          buttons: ["OK"],
          defaultId: 0,
        });
        return;
      }
      try {
        fs.accessSync(outputPath, fs.constants.R_OK);
        ++filesToBeReplaced;
      } catch (ex) { }
    }
    if (filesToBeReplaced > 0 && !skipReplaceConfirmation) {
      const single = filesToBeReplaced === 1;
      const selectedID = E.remote.dialog.showMessageBoxSync({
        type: "warning",
        title: "Replace Existing Files",
        message: `Replace existing file${single ? "" : `s`}?`,
        detail: `${
          single
            ? `"${files[0].name}" already exists`
            : `${filesToBeReplaced} files including "${files[0].name}" already exist`
          }. Replacing ${single ? "it" : "them"} will overwrite ${single ? "its" : "their"} existing contents.`,
        buttons: ["Replace", "Cancel"],
        defaultId: 0,
      });
      if (selectedID !== 0) {
        return;
      }
    }
    for (const file of files) {
      {
        const parts = file.name.split("/");
        parts.pop();
        let dirPath = directoryPath;
        for (const part of parts) {
          try {
            dirPath = path.join(dirPath, part);
            fs.mkdirSync(dirPath);
          } catch (ex) { }
        }
      }

      try {
        const outputPath = path.join(directoryPath, file.name);
        const opts = { encoding: "binary" };
        fs.writeFileSync(outputPath, Buffer.from(file.buffer), opts);
      } catch (ex) {
        E.remote.dialog.showMessageBox({
          type: "error",
          title: "Export Failed",
          message: "Saving file failed",
          detail: `"${file.name}" could not be saved. Remaining files will not be saved.`,
          buttons: ["OK"],
          defaultId: 0,
        });
      }
    }
  },
};

const init = (fileBrowser: boolean) => {
  window.addEventListener(
    "message",
    event => {
      // console.log(`window message, ${event.origin} === ${location.origin}, data, ports: `, event.data, event.ports);
      webPort = event.ports[0];
      console.log(`window message, webPort: `, webPort);
      webPort && (webPort.onmessage = onWebMessage);
      // console.log('window.__figmaDesktop.fileBrowser: ', window.__figmaDesktop.fileBrowser);
      // window.__figmaDesktop.fileBrowser = false;
    },
    { once: true },
  );

  const initWebOptions: IntiApiOptions = {
    version: API_VERSION,
    fileBrowser: fileBrowser,
    shortcutBinding: shortcutBinding.toString(),
    shortcutsMap,
    shortcutMan: ShortcutMan.toString(),
  };

  console.log("init(): window.parent.document: ", window.parent.document.body);

  initWebBindings();

  // console.log('api: ', api.toString());
  E.webFrame.executeJavaScript(`(${initWebApi.toString()})(${JSON.stringify(initWebOptions)})`);

  shortcuts();
};

export default init;
