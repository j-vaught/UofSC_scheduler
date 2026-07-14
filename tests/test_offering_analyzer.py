import unittest
from datetime import date

import offering_analyzer


class OfferingAnalyzerTests(unittest.TestCase):
    def test_current_academic_term_uses_active_semester(self):
        self.assertEqual(offering_analyzer.current_academic_term(date(2026, 4, 1)), "202601")
        self.assertEqual(offering_analyzer.current_academic_term(date(2026, 7, 1)), "202605")
        self.assertEqual(offering_analyzer.current_academic_term(date(2026, 10, 1)), "202608")

    def test_future_and_planned_terms_do_not_change_frequency(self):
        history = {
            "terms": [
                {"term": "202401", "offered": True},
                {"term": "202408", "offered": True},
                {"term": "202501", "offered": False},
                {"term": "202508", "offered": True},
                {"term": "202601", "offered": False},
                {"term": "202608", "offered": False},
                {"term": "202701", "offered": False},
            ],
        }

        result = offering_analyzer.analyze_offering_pattern(history, as_of_term="202601")

        self.assertEqual(result["total_terms_checked"], 4)
        self.assertEqual(result["times_offered"], 3)
        self.assertEqual(result["frequency"], 0.75)

    def test_unavailable_lookup_is_not_counted_as_not_offered(self):
        history = {
            "terms": [
                {"term": "202401", "offered": True},
                {"term": "202405", "offered": False, "error": True},
                {"term": "202408", "offered": False},
            ],
        }

        result = offering_analyzer.analyze_offering_pattern(history, as_of_term="202501")

        self.assertEqual(result["total_terms_checked"], 2)
        self.assertEqual(result["frequency"], 0.5)

    def test_enrollment_summary_accepts_common_backend_field_names(self):
        history = {
            "terms": [
                {"term": "202401", "offered": True, "enrollment": 20, "capacity": 25},
                {"term": "202408", "offered": True, "enrolled": "30", "max_enrollment": "40"},
                {"term": "202501", "offered": True},
            ],
        }

        result = offering_analyzer.analyze_offering_pattern(history, as_of_term="202508")

        self.assertEqual(result["enrollment"]["terms_with_data"], 2)
        self.assertEqual(result["enrollment"]["average_enrollment"], 25.0)
        self.assertEqual(result["enrollment"]["average_fill_rate"], 0.769)
        self.assertEqual(result["enrollment"]["latest_term"], "202408")


if __name__ == "__main__":
    unittest.main()
