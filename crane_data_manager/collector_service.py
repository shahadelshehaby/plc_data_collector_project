"""
collector_service.py - entry point of the collector Windows service.

Installed by install_service.bat (service name CraneDataCollector).
For a test run in a window:   python collector_service.py
"""
from cdm.collector import main

if __name__ == "__main__":
    main()
