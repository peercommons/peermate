# Field-test log lines in the iOS unified log (Release builds drop JS console output).
Pod::Spec.new do |s|
  s.name           = 'PeermateLog'
  s.version        = '0.1.0'
  s.summary        = 'App log lines in the unified log'
  s.license        = 'MIT'
  s.author         = 'Peermate'
  s.homepage       = 'https://example.invalid/peermate'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
