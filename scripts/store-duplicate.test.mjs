import assert from 'node:assert/strict'
import { test } from 'node:test'
import { duplicateRefusal, versionCode } from './store-duplicate.mjs'

// Gradle Play Publisher 3.12.1 with --stacktrace, when Play already has the
// version code: the plugin's own wrapper (DefaultEditManager
// .handleUploadFailures), then the Play Developer API's answer as its cause.
const playDuplicate = `* What went wrong:
Execution failed for task ':app:publishReleaseBundle'.
> A failure occurred while executing com.github.triplet.gradle.play.tasks.PublishBundle$BundleUploader
   > Version code is too low or has already been used for app io.slothworks.orbital.mobile.

* Exception is:
Caused by: java.lang.IllegalStateException: Version code is too low or has already been used for app io.slothworks.orbital.mobile.
Caused by: com.google.api.client.googleapis.json.GoogleJsonResponseException: 403 Forbidden
POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/io.slothworks.orbital.mobile/edits/1/bundles?uploadType=resumable
{
  "code" : 403,
  "errors" : [ {
    "domain" : "androidpublisher",
    "message" : "APK specifies a version code that has already been used.",
    "reason" : "forbidden"
  } ],
  "message" : "APK specifies a version code that has already been used.",
  "status" : "PERMISSION_DENIED"
}
`

// The same refusal in the form that names the code.
const playDuplicateNamed = `Caused by: com.google.api.client.googleapis.json.GoogleJsonResponseException: 400 Bad Request
{
  "code" : 400,
  "message" : "Version code 12 has already been used.",
  "status" : "INVALID_ARGUMENT"
}
`

// xcodebuild -exportArchive with destination upload, App Store Connect
// refusing a build number it has.
const ascDuplicate = `error: exportArchive The provided entity includes an attribute with a value that has already been used
Error Domain=IDEFoundationErrorDomain Code=1 "The provided entity includes an attribute with a value that has already been used" UserInfo={NSLocalizedDescription=The provided entity includes an attribute with a value that has already been used, NSLocalizedRecoverySuggestion=The bundle version must be higher than the previously uploaded version: ‘12’. (ID: 00000000-0000-0000-0000-000000000000)}
** EXPORT FAILED **
`
const ascDuplicateCode = `"code" : "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE",`
const itms90189 = `error: exportArchive: ERROR ITMS-90189: "Redundant Binary Upload. You've already uploaded a build with build number '12' for version number '0.8.0'. Make sure you increment the build string before you upload your app to App Store Connect."`

test('Play refusing the version code it has is a duplicate', () => {
  assert.match(
    duplicateRefusal('android', '12', playDuplicate),
    /APK specifies a version code that has already been used/,
  )
  assert.match(
    duplicateRefusal('android', '12', playDuplicateNamed),
    /Version code 12 has already been used/,
  )
})

test('App Store Connect refusing the build number it has is a duplicate', () => {
  assert.match(duplicateRefusal('ios', '12', ascDuplicate), /already been used/)
  assert.match(duplicateRefusal('ios', '12', ascDuplicateCode), /INVALID\.DUPLICATE/)
  assert.match(duplicateRefusal('ios', '12', itms90189), /Redundant Binary Upload/)
})

test("Gradle Play Publisher's own wrapper alone is not enough", () => {
  // It also stands for apkNoUpgradePath and apkUpgradeVersionConflict.
  const wrapperOnly = playDuplicate.split('Caused by: com.google')[0]
  assert.equal(duplicateRefusal('android', '12', wrapperOnly), null)
})

test('a refusal of another build number is not this one', () => {
  assert.equal(duplicateRefusal('android', '12', playDuplicateNamed.replace('12', '11')), null)
  assert.equal(duplicateRefusal('ios', '12', itms90189.replace("'12'", "'11'")), null)
  // Curly quotes, as newer tools print them, still name the number.
  assert.match(duplicateRefusal('ios', '12', itms90189.replace("'12'", '‘12’')), /Redundant/)
})

test('other failures are not duplicates', () => {
  // The first release's transient export failure.
  const transient = `error: exportArchive The data couldn’t be read because it isn’t in the correct format.
** EXPORT FAILED **`
  assert.equal(duplicateRefusal('ios', '12', transient), null)
  // "Must be higher" alone is also what a build number lower than the
  // store's says.
  assert.equal(
    duplicateRefusal(
      'ios',
      '12',
      'The bundle version must be higher than the previously uploaded version.',
    ),
    null,
  )
  assert.equal(
    duplicateRefusal(
      'ios',
      '12',
      'error: exportArchive No signing certificate "iOS Distribution" found',
    ),
    null,
  )
  const auth = `Caused by: com.google.api.client.googleapis.json.GoogleJsonResponseException: 401 Unauthorized
  "message" : "Request had invalid authentication credentials."`
  assert.equal(duplicateRefusal('android', '12', auth), null)
  // A store's duplicate is not the other platform's.
  assert.equal(duplicateRefusal('android', '12', ascDuplicate), null)
  assert.equal(duplicateRefusal('ios', '12', playDuplicate), null)
})

test('reads versionCode as the build number', () => {
  assert.equal(
    versionCode('    defaultConfig {\n        versionCode 12\n        versionName "0.8.0"\n'),
    '12',
  )
  assert.throws(() => versionCode('        // versionCode 12'), /no versionCode/)
})

test('an unknown platform is an error', () => {
  assert.throws(() => duplicateRefusal('web', '12', ''), /unknown platform/)
})
