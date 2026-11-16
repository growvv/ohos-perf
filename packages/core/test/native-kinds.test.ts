import { describe, it, expect } from 'vitest';
import { classifyNativePath } from '../src/analyze/native-kinds';

describe('classifyNativePath', () => {
  it('matches an exact path before any regex', () => {
    expect(
      classifyNativePath('/system/lib64/module/arkui/libcomponentutils.z.so', null, null),
    ).toMatchObject({ category: 2, categoryName: 'ArkUI' });
  });

  it('matches a regex rule', () => {
    expect(classifyNativePath('/system/lib64/module/app/ability/libx.z.so', null, null))
      .toMatchObject({ category: 3, categoryName: 'OS_Runtime' });
  });

  it('classifies bundle .so and .abc, refining an ArkTS symbol to its package', () => {
    // `libentry.so` is a CUBE rule in the table, so the app-bundle case needs a
    // name no component rule claims.
    const so = classifyNativePath(
      '/proc/1234/data/storage/el2/base/bundle/libs/arm64/libmyapp.so',
      null,
      null,
    );
    expect(so).toMatchObject({ category: 1, categoryName: 'APP', subCategory: 'libmyapp.so' });

    const abc = classifyNativePath(
      '/proc/1234/data/storage/el2/base/bundle/ets/modules.abc',
      'foo:[url:entry|com.demo|1.0.0|ets/pages/Index.ets:10:2]',
      null,
    );
    expect(abc).toMatchObject({ category: 1, categoryName: 'APP', subCategory: 'com.demo' });
  });

  it('lets a component rule beat the generic app-bundle rule', () => {
    // Upstream's component rules carry priority 10 and the bundle rule 0, so a
    // framework library inside an app's bundle directory keeps its framework
    // category.
    expect(
      classifyNativePath(
        '/proc/1234/data/storage/el2/base/bundle/libs/arm64/libentry.so',
        null,
        null,
      ),
    ).toMatchObject({ category: 5, categoryName: 'RN', subCategory: 'CUBE' });
  });

  it('refines a KMP symbol to its package', () => {
    const c = classifyNativePath(
      '/proc/1234/data/storage/el2/base/bundle/libs/arm64/libkmp_launcher.so',
      'kfun:com.demo.Native.main',
      null,
    );
    expect(c).toMatchObject({ category: 8, categoryName: 'KMP', subCategory: 'com.demo' });
  });

  it('lets a high-priority rule win over the app bundle rule', () => {
    // The bundle rule is priority 0; KMP's own rules are priority 10.
    expect(
      classifyNativePath(
        '/proc/1234/data/storage/el2/base/bundle/libs/arm64/libkmp_launcher.so',
        null,
        null,
      ).categoryName,
    ).toBe('KMP');
  });

  it('falls back to the basename, then SYS_SDK, then the thread', () => {
    expect(classifyNativePath('/vendor/lib64/libfoo.so', null, null)).toMatchObject({
      category: 4,
      categoryName: 'SYS_SDK',
      subCategory: 'libfoo.so',
    });
    expect(classifyNativePath(null, null, 'worker')).toMatchObject({
      category: -1,
      categoryName: 'Thread',
      subCategory: 'worker',
    });
    expect(classifyNativePath('', 'unknown', null)).toMatchObject({ categoryName: 'UNKNOWN' });
  });

  it('classifies a thread name against the thread rules', () => {
    expect(classifyNativePath(null, null, 'RNJS_3')).toMatchObject({
      category: 5,
      categoryName: 'RN',
    });
  });

  it('treats a rule as either exact or regex, never both', () => {
    // `/system/lib64/platformsdk/libability_manager.z.so` is an exact rule; it must
    // not also be compiled as a regex with `.` wildcards.
    expect(
      classifyNativePath('/system/lib64/platformsdk/libabilityXmanagerYzXso', null, null),
    ).toMatchObject({ categoryName: 'SYS_SDK' });
  });
});
