// Replaces the `flutter create` default counter-app smoke test (which
// referenced the scaffolded `MyApp`, removed when this app became the
// Rovenue SDK example — see `lib/main.dart`). The real end-to-end coverage
// lives in `integration_test/smoke_test.dart`; this file just keeps `flutter
// test` (run without a path argument) from failing on a stale reference.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rovenue_flutter_example/main.dart';

void main() {
  testWidgets('renders the loading state before configure() resolves', (tester) async {
    await tester.pumpWidget(const RovenueExampleApp());

    // Before the very first frame after `configure()` completes, the app
    // shows a loading spinner rather than a half-initialized screen.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Rovenue Flutter Example'), findsOneWidget);
  });
}
