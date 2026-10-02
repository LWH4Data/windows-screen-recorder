# 화면 녹화 — Screen Recorder

Windows와 Mac에서 화면 설명, 강의, 프로그램 사용법 영상을 녹화하는 Electron 앱입니다. 영상은 사용자가 선택한 로컬 폴더에 저장하며, 서버로 전송하지 않습니다. 현재 소스 버전은 **1.1.0**입니다.

![합성 화면으로 검증한 화면 녹화 앱 예시](docs/preview.png)

위 이미지는 합성 화면을 사용한 테스트 예시이며 실제 사용자 화면이나 녹화 영상을 포함하지 않습니다.

## 지원 환경

| 환경 | 화면·마이크 녹화 | 컴퓨터 소리 녹음 |
| --- | --- | --- |
| Windows 10/11, x64 | 지원 | 지원 |
| macOS 13~14.1, Apple Silicon / Intel | 지원 | 해당 옵션 비활성화 |
| macOS 14.2 이상, Apple Silicon / Intel | 지원 | 시스템 오디오 권한 허용 필요 |

Mac은 Apple Silicon용 `arm64`와 Intel용 `x64` 빌드 경로를 제공합니다. 이번 Mac 실행·캡처 검증은 **Apple Silicon / macOS 26.6.2**에서 수행했습니다. Intel Mac에서의 실제 실행은 별도 확인이 필요합니다.

## 설치와 실행

### Windows

[Windows 실행용 ZIP 다운로드](https://github.com/LWH4Data/screen-recorder-test/releases/latest/download/ScreenRecorder-Windows.zip)

1. ZIP의 **폴더 전체**를 압축 해제합니다.
2. 폴더 안의 `ScreenRecorder.exe`를 실행합니다.

실행 파일만 따로 옮기면 실행되지 않습니다. 배포 파일에 Electron 런타임이 포함되므로 별도 Node.js 설치가 필요 없습니다. 현재 공개된 Windows Release는 **v1.0.0**이며, 최신 소스의 변경 사항은 아래 빌드 방법으로 사용할 수 있습니다.

### Mac

Mac 실행용 ZIP은 아직 GitHub Release에 게시하지 않았습니다. 최신 소스를 Mac에서 빌드하려면 **Node.js 22.12 이상과 npm, Git**을 설치한 뒤 다음 명령을 실행합니다.

```sh
git clone https://github.com/LWH4Data/screen-recorder-test.git
cd screen-recorder-test
npm ci
npm run package
```

| Mac 종류 | 생성되는 앱 |
| --- | --- |
| Apple Silicon | `dist/ScreenRecorder-macOS-arm64/Screen Recorder.app` |
| Intel | `dist/ScreenRecorder-macOS-x64/Screen Recorder.app` |

1. 생성된 **`Screen Recorder.app` 전체**를 응용 프로그램 폴더에 복사합니다.
2. 앱을 실행하고 화면 녹화 권한을 허용합니다.
3. 이후 Spotlight(`Cmd + Space`)에서 **Screen Recorder**로 검색해 실행할 수 있습니다.

배포 `.app`에는 런타임이 포함되므로 실행할 컴퓨터에 Node.js가 필요하지 않습니다. `.app` 내부 파일은 따로 옮기지 마세요. Mac 빌드는 로컬 ad hoc 서명이며 Apple Developer ID 서명·공증은 포함하지 않습니다. 다운로드한 앱이 차단되면 출처를 확인한 뒤 시스템 설정 → 개인정보 보호 및 보안의 해당 앱 열기 안내를 따르세요.

## 녹화 방법

1. **전체 화면** 또는 **특정 창** 탭에서 녹화 대상을 선택합니다.
2. 영상 크기·프레임·화질·저장 형식과 소리 설정을 확인합니다.
3. **녹화 시작**을 누르고 저장할 폴더와 파일 이름을 선택합니다.
4. 필요하면 **일시정지 / 녹화 재개**를 사용합니다.
5. **녹화 중지** 후 저장 완료 안내가 나타나면 **저장 위치 열기**로 파일을 확인합니다.

기본 설정은 최대 1080p / 30fps / 표준 화질입니다. 실행 환경이 지원하면 MP4(H.264/AAC)를 사용하며, WebM을 대체 형식으로 제공합니다. 녹화 시작 시 창을 자동으로 최소화하는 옵션도 있습니다.

### 프로그램 소리와 마이크

- **프로그램에서 나는 소리만 녹음:** `컴퓨터 소리`를 켜고 `마이크`를 끕니다.
- **프로그램 소리와 내 목소리를 함께 녹음:** 두 옵션을 모두 켭니다. 마이크 장치와 음량을 선택할 수 있습니다.
- **소리 없이 화면만 녹화:** 두 옵션을 모두 끕니다.

`컴퓨터 소리`는 선택한 창의 소리만 분리하지 않습니다. **다른 앱과 알림을 포함한 컴퓨터 전체의 재생 소리**를 녹음합니다. 마이크는 기본적으로 꺼져 있습니다. 컴퓨터 소리와 마이크를 함께 사용할 때는 헤드폰으로 울림을 줄일 수 있습니다.

### Mac 권한 설정

시스템 설정 → **개인정보 보호 및 보안**에서 다음 권한을 확인합니다.

| 권한 | 필요한 경우 |
| --- | --- |
| 화면 및 시스템 오디오 녹음(버전에 따라 화면 기록) | 화면 녹화 및 컴퓨터 소리 녹음 |
| 마이크 | 마이크 옵션을 켜서 목소리를 녹음할 때 |

- 배포 앱의 이름은 **Screen Recorder**입니다. 화면 권한이 없으면 앱에서 설정 열기 버튼을 제공합니다.
- 처음 마이크를 사용하는 녹화에서는 macOS가 마이크 권한을 요청합니다. 거부했다면 위 설정에서 허용하거나 마이크 옵션을 끕니다.
- 권한을 변경한 뒤 시스템이 요청하면 앱을 종료하고 다시 실행합니다. 화면 목록도 새로고침할 수 있습니다.
- Mac의 컴퓨터 소리 녹음은 **macOS 14.2 이상**에서 지원합니다. 시스템 오디오 접근 요청이 표시되면 허용합니다.
- `npm start`로 실행하면 권한 대상이 **Electron** 또는 터미널·IDE로 표시될 수 있습니다. 부모 앱의 오디오 권한 선언에 따라 무음 스트림이 생성될 수 있으므로, **시스템 오디오 확인에는 배포 `.app`을 직접 실행**합니다.

Windows에서 마이크를 사용할 때는 Windows 개인정보 설정에서 데스크톱 앱의 마이크 접근을 허용해야 할 수 있습니다.

### 단축키와 최소화된 앱 열기

| 기능 | Windows | Mac |
| --- | --- | --- |
| 일시정지 / 재개 | `Ctrl + Shift + F9` | `Cmd + Shift + F9` |
| 녹화 중지 | `Ctrl + Shift + F10` | `Cmd + Shift + F10` |

Mac에서 기능 키가 음량·미디어를 조절하면 `Fn` 키도 함께 누릅니다. 다른 앱이 단축키를 사용하면 등록되지 않을 수 있습니다. 창의 버튼이나 **Windows 알림 영역 / Mac 메뉴 막대**에서도 녹화를 제어할 수 있습니다. Mac에서는 Dock으로 창을 다시 열 수도 있습니다.

## 소스 실행과 배포 빌드

Node.js **22.12 이상**과 npm이 필요합니다. 프로젝트 폴더에서 실행합니다.

```sh
npm ci
npm start
```

Electron 실행 파일이 없거나 자동 다운로드에 실패했다면 네트워크 연결을 확인하고 다음 명령으로 런타임을 설치한 뒤 다시 실행합니다.

```sh
node node_modules/electron/install.js
npm start
```

배포 폴더는 **배포할 운영체제에서 해당 아키텍처의 Node.js와 Electron 런타임**으로 생성합니다.

```sh
npm run package
```

| 빌드 환경 | 기본 출력 |
| --- | --- |
| Windows x64 | `dist/ScreenRecorder-Windows/ScreenRecorder.exe` |
| Mac arm64 | `dist/ScreenRecorder-macOS-arm64/Screen Recorder.app` |
| Mac x64 | `dist/ScreenRecorder-macOS-x64/Screen Recorder.app` |

호스트와 설치된 런타임의 운영체제·아키텍처가 다르면 빌드를 거부합니다. Mac 빌드는 시스템의 `plutil`과 `codesign`으로 앱과 보조 프로세스의 이름·권한 설명·로컬 서명을 설정하고 서명을 검증합니다.

기존 배포 폴더는 덮어쓰지 않습니다. 이전 결과를 별도 보관하거나 `SCREEN_RECORDER_OUTPUT_DIR` 환경 변수로 다른 출력 폴더를 지정하세요. 배포 폴더 전체를 ZIP으로 묶고 Electron·Chromium 라이선스 안내도 함께 전달합니다. `package.json`의 `private: true`는 npm에 의도치 않게 게시하는 것을 방지합니다.

## 개발용 검증

```sh
npm test
node scripts/integration.cjs
```

- 단위 테스트 **24개:** 녹화 데이터 순서·부분 쓰기·파일 보호·저장 오류·임시 파일 보존, 운영체제별 오디오 지원과 단축키, 배포 파일 구성·아키텍처 검사·덮어쓰기 방지·서명 실패 처리를 검사합니다.
- 통합 검사: 합성 화면·오디오로 실제 MediaRecorder, MP4 저장과 재생, 일시정지/재개, 권한 거부 후 복구를 검사합니다.

Mac 배포 앱 검사는 다음 경로를 사용합니다. Intel Mac에서는 `arm64`를 `x64`로 바꿉니다.

```sh
node scripts/package-smoke.cjs "dist/ScreenRecorder-macOS-arm64/Screen Recorder.app"
node scripts/capture-smoke.cjs "dist/ScreenRecorder-macOS-arm64/Screen Recorder.app"
```

Windows에서는 다음과 같이 `.exe` 경로를 전달합니다.

```powershell
node scripts/package-smoke.cjs "dist/ScreenRecorder-Windows/ScreenRecorder.exe"
node scripts/capture-smoke.cjs
```

배포 시작 검사는 실제 배포 앱의 시작과 MP4 지원을 확인합니다. 캡처 검사는 별도의 합성 창을 실제 캡처하고 화면·오디오 트랙이 유지되는지 확인합니다. Mac에서는 작은 합성음을 재생해 실제 시스템 오디오 샘플 입력도 확인합니다. 녹화 영상은 저장하지 않지만 화면 목록의 썸네일은 메모리에서 열람하며 화면 녹화 권한이 필요합니다.

## 사용 전 확인과 제한

- 긴 녹화 전에 **짧게 시험 녹화하고 저장된 영상과 소리를 재생**하세요. 실제 해상도·프레임·비트레이트·MP4 지원과 음성 싱크는 컴퓨터와 장치에 따라 달라집니다.
- 전체 화면 녹화에는 이 앱의 창, 알림, 저장 대화상자가 나타날 수 있습니다. 앱 자체는 녹화 대상 목록에서 제외됩니다.
- 기존 파일은 덮어쓰지 않습니다. 기록 중에는 `<파일명>.recording` 임시 파일을 사용하며 저장 오류가 나면 보존합니다. 강제 종료 후 복구를 보장하지는 않습니다. 충분한 디스크 공간을 확보하세요.
- 복사 방지 영상, 관리자 권한 창, 잠긴 화면 등은 검은 화면으로 보이거나 캡처가 중단될 수 있습니다.
- 게임 전용 캡처, 자유 영역 선택, 웹캠, 영상 편집, YouTube 자동 업로드는 포함하지 않습니다.
- Windows 앱은 전자 서명되지 않았으며 실행 확인이 나타날 수 있습니다.

추가 안내는 [사용법.txt](사용법.txt)를 참고하세요.
