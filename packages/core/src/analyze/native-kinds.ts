// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.
//
// The rule table is HapRay's `tools/static_analyzer/res/perf/kind.json`
// (7 kinds, 22 components, 125 path rules, 25 thread rules), preserved in file
// order. Rules are split once at module load: a rule containing any of `$`,
// `.*`, `.+` or `d+` is compiled as a regex, everything else is an exact key.
// Upstream loads the same list into both a dict and a regex list, so a rule
// with a metacharacter is matched both ways and exact precedence is accidental;
// here each rule is exactly one of the two.

/** Category ids, matching upstream's `ComponentCategory`. */
const CATEGORY = {
  APP: 1,
  ArkUI: 2,
  OS_Runtime: 3,
  SYS_SDK: 4,
  RN: 5,
  Flutter: 6,
  WEB: 7,
  KMP: 8,
  UNKNOWN: -1,
} as const;

/** Where a native file or thread belongs in the component hierarchy. */
export interface NativeCategory {
  /** `ComponentCategory` id; `-1` when nothing matched. */
  category: number;
  categoryName: string;
  /** Component name, package name, basename or thread name, depending on the rule. */
  subCategory: string;
  /** The classified path; the ArkTS package path for a refined `.abc` frame. */
  file: string;
}

interface NativeRuleComponent {
  name: string;
  priority: number;
  files: readonly string[];
  threads?: readonly string[];
}

interface NativeKindRule {
  name: string;
  kind: number;
  components: readonly NativeRuleComponent[];
}

const KINDS: readonly NativeKindRule[] = [
  {
    name: "APP",
    kind: 1,
    components: [
      {
        name: "APP_ABC",
        priority: 0,
        files: [
          "/proc/.*/data/storage/(?!.*/bundle/.*\\.so$)(?!.*/bundle/libs/).*",
        ],
      },
      {
        name: "APP_SO",
        priority: 0,
        files: [
          "/proc/.*/data/storage/.*/bundle/(.*\\.so|libs/.*)",
        ],
      },
    ],
  },
  {
    name: "ArkUI",
    kind: 2,
    components: [
      {
        name: "ArkUI",
        priority: 10,
        files: [
          "/system/etc/abc/framework/stateMgmt.abc",
          "/system/lib64/libace_ndk.z.so",
          "/system/lib64/module/arkui/libcomponentsnapshot.z.so",
          "/system/lib64/module/arkui/libcomponentutils.z.so",
          "/system/lib64/module/arkui/libfocuscontroller.z.so",
          "/system/lib64/module/arkui/libinspector.z.so",
          "/system/lib64/module/arkui/libobserver.z.so",
          "/system/lib64/platformsdk/libace_compatible.z.so",
          "/system/lib64/platformsdk/libace_container_scope.z.so",
          "/system/lib64/platformsdk/libace_forward_compatibility.z.so",
          "/system/lib64/platformsdk/libace_network.z.so",
          "/system/lib64/platformsdk/libace_uicontent.z.so",
        ],
      },
    ],
  },
  {
    name: "OS_Runtime",
    kind: 3,
    components: [
      {
        name: "Ability",
        priority: 10,
        files: [
          "/system/lib64/chipset-pub-sdk/libextractortool.z.so",
          "/system/lib64/module/ability/libfeatureability.z.so",
          "/system/lib64/module/ability/libwantconstant.z.so",
          "/system/lib64/module/app/ability/.*.z.so",
          "/system/lib64/module/application/libappmanager_napi.z.so",
          "/system/lib64/platformsdk/libability_manager.z.so",
          "/system/lib64/platformsdk/libability_thread.z.so",
          "/system/lib64/platformsdk/libabilitykit_native.z.so",
          "/system/lib64/platformsdk/libace_napi.z.so",
          "/system/lib64/platformsdk/libappkit_native.z.so",
          "/system/lib64/platformsdk/libconfiguration.z.so",
          "/system/lib64/platformsdk/libcontinuation_ipc.z.so",
          "/system/lib64/platformsdk/libjs_environment.z.so",
          "/system/lib64/platformsdk/libruntime.z.so",
          "/system/lib64/platformsdk/libuiabilitykit_native.z.so",
        ],
      },
      {
        name: "ArkTS Runtime",
        priority: 10,
        files: [
          "/system/lib64/libark_jsoptimizer.so",
          "/system/lib64/module/arkcompiler/stub.an",
          "/system/lib64/module/arkts/libcollections.z.so",
          "/system/lib64/platformsdk/libark_jsruntime.so",
        ],
        threads: [
          "OS_GC_Thread",
        ],
      },
      {
        name: "ArkTS System LIB",
        priority: 10,
        files: [
          "anon:ArkTS Code:.*",
        ],
      },
      {
        name: "JS Engine",
        priority: 10,
        files: [
          "/system/lib64/libv8_shared.so",
          "/system/lib64/ndk/libjsvm.so",
        ],
      },
    ],
  },
  {
    name: "RN",
    kind: 5,
    components: [
      {
        name: "RN",
        priority: 10,
        files: [
          ".*libhermes.so",
          ".*librnoh.so",
          "/proc/.*/data/storage/.*/bundle/.*libjsi.so$",
          "/proc/.*/data/storage/.*/bundle/.*libjsvm.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_config.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_nativemodule_core.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_animations.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_attributedstring.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_componentregistry.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_core.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_graphics.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_imagemanager.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_leakchecker.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_mapbuffer.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_mounting.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_runtimescheduler.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_scheduler.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_telemetry.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_templateprocessor.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_textlayoutmanager.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreact_render_unimanager.so$",
          "/proc/.*/data/storage/.*/bundle/.*libreactnative.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_app.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_async_storage.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_core.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_core_package.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_datetime_picker.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_flash_list.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_fs.so$",
          "/proc/.*/data/storage/.*/bundle/.*librnoh_gesture_handler.so$",
          "/proc/.*/data/storage/.*/bundle/.*libv8_shared.so$",
        ],
        threads: [
          "RNOH_BACKGROUND",
          "RNOH_CLEANUP",
          "RNOH_JS",
          "V8 DefaultWorke",
          "RNJS_\\d+",
        ],
      },
      {
        name: "AJX",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libajx.so$",
          "/proc/.*/data/storage/.*/bundle/.*libajxbiz2.so$",
        ],
      },
      {
        name: "CUBE",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libantcube.so$",
          "/proc/.*/data/storage/.*/bundle/.*libBifrost.so$",
          "/proc/.*/data/storage/.*/bundle/.*libBloxohos.so$",
          "/proc/.*/data/storage/.*/bundle/.*libcube.so$",
          "/proc/.*/data/storage/.*/bundle/.*libentry.so$",
        ],
      },
      {
        name: "DX",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libdinamicx.so$",
          "/proc/.*/data/storage/.*/bundle/.*libtbdinamicx.so$",
        ],
      },
      {
        name: "Hippy",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libhippy.so$",
        ],
      },
      {
        name: "Lynx",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*liblynx.so$",
          "/proc/.*/data/storage/.*/bundle/.*liblynx_security_service.so$",
        ],
      },
      {
        name: "MRN",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libmrn.so$",
        ],
      },
      {
        name: "MSC",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libmsc.so$",
          "/proc/.*/data/storage/.*/bundle/.*libmscjsi.so$",
        ],
      },
      {
        name: "Taro",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libJDTaroNativeOH.so$",
          "/proc/.*/data/storage/.*/bundle/.*libtaro_native_core.so$",
          "/proc/.*/data/storage/.*/bundle/.*libTaroHarmonyLibrary.so$",
          "/proc/.*/data/storage/.*/bundle/.*libSilkTaroKit.so$",
          "/proc/.*/data/storage/.*/bundle/.*libtaronativelib.so$",
        ],
      },
    ],
  },
  {
    name: "Flutter",
    kind: 6,
    components: [
      {
        name: "Flutter",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libflutter.so$",
        ],
        threads: [
          "\\d+\\.io",
          "\\d+\\.raster",
          "\\d+\\.ui",
          "dart",
          "DartWorker",
          "dart:io EventHa",
          "io.flutter.work",
          "io.worker.",
        ],
      },
      {
        name: "Weex",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libweex_ability.so$",
          "/proc/.*/data/storage/.*/bundle/.*libweex_framework.so$",
        ],
      },
    ],
  },
  {
    name: "WEB",
    kind: 7,
    components: [
      {
        name: "WEB",
        priority: 10,
        files: [
          ".*libarkweb_engine.so",
          ".*libarkweb_render.so",
          ".*NWeb.hap",
          "/proc/.*/bundle/arkwebcore/libs/arm64/.*\\.so$",
          "/system/lib64/libapp_fwk_update_service.z.so",
          "/system/lib64/libarkweb_core_loader_glue.z.so",
          "/system/lib64/libarkweb_glue_base.z.so",
          "/system/lib64/libnweb_ohos_wrapper.z.so",
          "/system/lib64/libohos_adapter_glue_source.z.so",
          "/system/lib64/libweb_configs.z.so",
          "/system/lib64/libwebview_common.z.so",
          "/system/lib64/module/web/libneterrorlist_napi.z.so",
          "/system/lib64/module/web/libwebview_napi.z.so",
          "/system/lib64/ndk/libohweb.so",
          "/system/lib64/platformsdk/libarkweb_core_loader.z.so",
          "/system/lib64/platformsdk/libarkweb_utils.z.so",
          "/system/lib64/platformsdk/libcj_webview_ffi.z.so",
          "/system/lib64/platformsdk/libnweb_ohos_adapter.z.so",
        ],
        threads: [
          "Chrome_ChildIOT",
          "Chrome_InProcGp",
          "Chrome_IOThread",
          "Compositor",
          "CompositorGpuTh",
          "CompositorTileW",
          "ThreadPoolForeg",
          "VizCompositorTh",
          "VSync-webview",
          "gpu-work-server",
          "ThreadPoolServi",
        ],
      },
      {
        name: "XWEB",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libfeat_webview.so$",
          "/proc/.*/data/storage/.*/bundle/.*libfeat_xweb.so$",
          "/proc/.*/data/storage/.*/bundle/.*libxweb_glue.so$",
          "/proc/.*/data/storage/.*/bundle/.*libxwebadapter.so$",
          "/proc/.*/data/storage/.*/bundle/.*libxwebcore.so$",
        ],
      },
    ],
  },
  {
    name: "KMP",
    kind: 8,
    components: [
      {
        name: "KMP Runtime",
        priority: 10,
        files: [
          "/proc/.*/data/storage/.*/bundle/.*libALIPAYKMP.so$",
          "/proc/.*/data/storage/.*/bundle/.*libconnectionclass.so$",
          "/proc/.*/data/storage/.*/bundle/.*libkmp_launcher.so$",
          "/proc/.*/data/storage/.*/bundle/.*libkn.so$",
          "/proc/.*/data/storage/.*/bundle/.*libkntr.so$",
          "/proc/.*/data/storage/.*/bundle/.*libkuikly_qqmusic.so$",
          "/proc/.*/data/storage/.*/bundle/.*liblauncher.so$",
          "/proc/.*/data/storage/.*/bundle/.*libshared.so$",
          "/proc/.*/data/storage/.*/bundle/.*libtaolivekmp.so$",
          "/proc/.*/data/storage/.*/bundle/.*libTBKMP.so$",
          "/proc/.*/data/storage/.*/bundle/.*libtkmp.so$",
        ],
      },
      {
        name: "CMP",
        priority: 10,
        files: [
          "/proc/.*/bundle/libs/arm64/libskikobridge.so",
        ],
      },
    ],
  },
];

interface Rule {
  category: NativeCategory;
  priority: number;
}

/** Upstream's `hasRegexChart`: a rule is a regex when it contains a metacharacter. */
function isRegex(rule: string): boolean {
  return rule.includes('$') || rule.includes('.*') || rule.includes('.+') || rule.includes('d+');
}

/**
 * The APP kind's two rules are the bundle-path rule and are applied as their
 * own step, because they set the sub-category from the path and the symbol
 * rather than from the rule name.
 */
const APP_KIND = 1;

function categoryOf(kind: NativeKindRule, component: string, subCategory: string): NativeCategory {
  return { category: kind.kind, categoryName: kind.name, subCategory, file: '' };
}

/** Exact path rules, keyed by the rule text. */
const EXACT = new Map<string, NativeCategory>();
/** Regex rules, highest priority first; ties keep file order. */
const REGEX: Array<{ regex: RegExp; category: NativeCategory; priority: number }> = [];
/** Thread rules, highest priority first; ties keep file order. */
const THREADS: Array<{ regex: RegExp; category: NativeCategory; priority: number }> = [];

for (const kind of KINDS) {
  if (kind.kind === APP_KIND) continue;
  for (const component of kind.components) {
    const priority = component.priority ?? 0;
    for (const rule of component.files) {
      if (isRegex(rule)) {
        REGEX.push({ regex: new RegExp(rule), category: categoryOf(kind, component.name, component.name), priority });
      } else {
        EXACT.set(rule, categoryOf(kind, component.name, component.name));
      }
    }
    for (const rule of component.threads ?? []) {
      THREADS.push({ regex: new RegExp(rule), category: categoryOf(kind, component.name, component.name), priority });
    }
  }
}

function byPriority(a: Rule, b: Rule): number {
  return b.priority - a.priority;
}

REGEX.sort(byPriority);
THREADS.sort(byPriority);

/** Upstream's bundle rule: a path under a sandboxed app's `bundle/` directory. */
const BUNDLE_SO = /^\/proc\/.*\/data\/storage\/.*\/bundle\/(.*\.so|libs\/.*)$/;
const BUNDLE_ABC = /^\/proc\/.*\/data\/storage\/.*\/bundle\/.*\.abc$/;

/** `fn:[url:entry|package|version|path:line:col]` — group 3 is the package. */
const ARKTS_SYMBOL = /^([^:]+):\[url:([^:|]+)\|([^|]+)\|([^:|]+)\|([^|]*):(\d+):(\d+)\]$/;

function basename(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

/**
 * The Kotlin package of a `kfun:` symbol.
 *
 * Upstream drops the function segment and then narrows the class path through
 * the app's module map, which a trace does not carry. Without that map the
 * class path is narrowed structurally: the function segment goes, then trailing
 * capitalised class segments, leaving the lowercase package prefix.
 */
function kmpPackage(symbol: string): string {
  const path = symbol.slice('kfun:'.length).split('#')[0];
  const segments = path.split('.').filter((s) => s.length > 0);
  if (segments.length <= 1) return 'kotlin';
  segments.pop();
  while (segments.length > 1 && /^[A-Z]/.test(segments[segments.length - 1])) segments.pop();
  return segments.join('.');
}

/**
 * Refines a file classification with the leaf symbol.
 *
 * Only two cases are refinements upstream performs: an ArkTS frame's package
 * and a KMP frame's Kotlin package. Everything else keeps the file's
 * sub-category, so a symbol never silently reclassifies a system library.
 */
function refine(base: NativeCategory, symbol: string | null): NativeCategory {
  if (symbol === null) return base;
  if (base.category === CATEGORY.APP && base.subCategory !== basename(base.file)) {
    // Already refined by the ArkTS rule.
    return base;
  }
  if (base.category === CATEGORY.KMP && symbol.startsWith('kfun:')) {
    return { ...base, subCategory: kmpPackage(symbol) };
  }
  return base;
}

/**
 * Classifies a native file, its leaf symbol and its thread.
 *
 * Precedence: exact path, then regex rules by priority, then the app bundle
 * rule, then an exact basename, then `SYS_SDK`. A symbol refines an app `.abc`
 * frame to its ArkTS package and a KMP frame to its Kotlin package. When there
 * is no usable file the thread rules decide, and a thread that matches nothing
 * is reported as `Thread` rather than `SYS_SDK`.
 */
export function classifyNativePath(
  filePath: string | null,
  symbol: string | null,
  thread: string | null,
): NativeCategory {
  const file = filePath ?? '';
  const usable = file.length > 0 && file !== 'unknown';

  if (!usable) {
    if (thread !== null && thread.length > 0) {
      for (const rule of THREADS) {
        if (rule.regex.test(thread)) return { ...rule.category, file: '' };
      }
      return { category: CATEGORY.UNKNOWN, categoryName: 'Thread', subCategory: thread, file: '' };
    }
    return { category: CATEGORY.UNKNOWN, categoryName: 'UNKNOWN', subCategory: 'unknown', file: '' };
  }

  const exact = EXACT.get(file);
  if (exact !== undefined) return refine({ ...exact, file }, symbol);

  for (const rule of REGEX) {
    if (rule.regex.test(file)) return refine({ ...rule.category, file }, symbol);
  }

  if (BUNDLE_SO.test(file) || BUNDLE_ABC.test(file)) {
    const base = basename(file);
    if (BUNDLE_ABC.test(file) && symbol !== null) {
      const match = ARKTS_SYMBOL.exec(symbol);
      if (match !== null) {
        const [, , , packageName, version, path] = match;
        return {
          category: CATEGORY.APP,
          categoryName: 'APP',
          subCategory: packageName,
          file: `${packageName}/${version}/${path}`,
        };
      }
    }
    return { category: CATEGORY.APP, categoryName: 'APP', subCategory: base, file };
  }

  const byBase = EXACT.get(basename(file));
  if (byBase !== undefined) return refine({ ...byBase, file }, symbol);

  return { category: CATEGORY.SYS_SDK, categoryName: 'SYS_SDK', subCategory: basename(file), file };
}
